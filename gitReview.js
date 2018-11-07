'use strict'

const octokit = new Octokit()

const diffHunkExpression = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/g

function Comment(response) {
  this.author = response.user.login
  this.content = response.body

  this.filename = response.path
  this.id = response.id
  this._originalResponse = response
  this.child = undefined

  //reset state
  diffHunkExpression.lastIndex = 0;
  const hunk_matches = diffHunkExpression.exec(response.diff_hunk)
  this.hunk_info = convertHunk(hunk_matches);

  // the original_position is 1 based
  this.lineNumber = this.hunk_info.updated_line + response.original_position - 1;
}

function RepoWrapper(owner, repo) {
  this.getDefaultOptions = getDefaultRepoOptionsFunction(owner, repo);
  this.getPullRequestComments = async function(pullNumber) {
    const opts = this.getDefaultOptions();
    opts.number = pullNumber;
    // opts.per_page = 100
    const commentsByFileNameByLine = new PullReviewComments();
    let {
      data,
      headers,
      status
    } = await octokit.pullRequests.getComments(opts)
    handleError(data, headers, status)

    for (const rawComment of data) {
      commentsByFileNameByLine.addRawComment(rawComment);
    }

    if (headers.link !== undefined) {
      let promises = [];

      let last_page = getLastPageNumber(headers.link);
      for (let i = 2; i <= last_page; i++) {
        opts.page = i;
        promises.push(octokit.pullRequests.getComments(opts));
      }

      let resolvedPromises = await Promise.all(promises)
      for (const resolvedPromise of resolvedPromises) {
        let {
          data,
          headers,
          status
        } = resolvedPromise;
        handleError(data, headers, status)
        if (status != 200) {
          handleError(data, headers, status);
        }

        for (const rawComment of data) {
          commentsByFileNameByLine.addRawComment(rawComment);
        }
      }
    }

    return commentsByFileNameByLine;
  };

  this.getPullRequest = async function(pullNumber) {
    const opts = this.getDefaultOptions();
    opts.number = pullNumber;
    let {
      data,
      headers,
      status
    } = await octokit.pullRequests.get(opts);
    handleError(data, headers, status);
    return data;
  };

  this.diffType = "DIFF";
  this.patchType = "PATCH";
  this.commitType = "COMMIT";

  this.getShaDiff = async function(baseSha, headSha, diff_type = undefined) {
    const opts = this.getDefaultOptions()
    opts.base = baseSha;
    opts.head = headSha;
    if (diff_type === this.patchType) {
      opts.headers = {
        "Accept": "application/vnd.github.v3.patch"
      }
    } else if (diff_type === this.diffType) {
      opts.headers = {
        "Accept": "application/vnd.github.v3.diff"
      }
    }

    let {
      data,
      headers,
      status
    } = await octokit.repos.compareCommits(opts);
    handleError(data, headers, status);
    return new Diff(baseSha, headSha, data);
  };

  this.getPullRequestDiff = async function(pullNumber) {
    let data = await this.getPullRequest(pullNumber);
    return await this.getShaDiff(data.base.sha, data.head.sha, this.diffType);
  }
}

function handleError(data, headers, status) {
  if (status < 200 && status >= 300) {
    console.log(status);
    console.log(headers);
    console.log(data);
    throw "error happened";
  }
}


function getLastPageNumber(link) {
  for (const s of link.split(", ")) {
    if (s.includes('rel="last')) {
      return parseInt(s.substring(s.indexOf('page=') + 5, s.indexOf('>')))
    }
  }

  throw "Couldn't find last page link";
}



function PullReviewComments() {
  this.filesToLinnumberToCommentThread = new Map();
  this.addRawComment = function(rawComment) {
    let comment = new Comment(rawComment)
    let threads = this.getCommentThreads(comment.filename, comment.lineNumber);
    this.addCommentToThreads(threads, comment)
  };

  this.getCommentThreads = function(filename, lineNumber) {
    let val = this.filesToLinnumberToCommentThread.get(filename);
    if (val === undefined) {
      val = new Map();
      this.filesToLinnumberToCommentThread.set(filename, val);
    }

    let threads = val.get(lineNumber);
    if (threads === undefined) {
      threads = new Array();
      val.set(lineNumber, threads);
    }

    return threads;
  };

  this.addCommentToThreads = function(threads, comment) {
    for (const thread of threads) {
      if (this.addToThisThread(thread, comment)) {
        return;
      }
    }

    threads.push(comment)
  };

  this.addToThisThread = function(thread, comment) {
    const commentParentId = comment._originalResponse.in_reply_to_id;
    let iterComment = thread
    while (iterComment !== undefined) {
      // both the reply and the reply to the reply have the same in_reply_to_id value
      if (iterComment.id === commentParentId && iterComment.child === undefined) {
        iterComment.child = comment;
        return true;
      }

      iterComment = iterComment.child;
    }

    return false;
  };

  this.toString = function() {
    let string = "";
    let totalComments = 0
    this.filesToLinnumberToCommentThread.forEach((lineNumberToComments, file) => {
      string += `${file}\n`;
      lineNumberToComments.forEach((threads, lineNumber) => {
        threads.forEach((commentThread) => {
          string += `\t${lineNumber}:\n`;
          let commentIter = commentThread;
          while (commentIter !== undefined) {
            totalComments += 1;
            string += `\t\t${commentIter.author}: ${commentIter.content}\n`;
            commentIter = commentIter.child;
          }
        });
      });
    });

    console.log("total comments " + totalComments)
    return string;
  };
}

function Diff(sha1, sha2, raw_diff) {
  this._raw = raw_diff;
  this.baseSha = sha1;
  this.headSha = sha2;
  this.fileDiffs = []
  for (const raw_file_diff of raw_diff.split(/^diff --git /gm)) {
    // First value in array is empty string
    if (raw_file_diff.length > 0) {
      this.fileDiffs.push(new FileDiff(raw_file_diff));
    }
  }

  this.toString = function() {
    let string = `diff from ${this.baseSha} to ${this.headSha}\n`;
    for (const fileDiff of this.fileDiffs) {
      string += fileDiff.toString().replace(/^/gm, "\t") + "\n";
    }

    return string;
  }
}

function FileDiff(raw_file_diff) {
  this._raw = raw_file_diff;
  this.updatedFileName = ""
  const lines = raw_file_diff.split("\n");
  let lineNumber = 0;
  //find the orignal file name
  while (lineNumber < lines.length) {
    // there is usually 2,3 lines of unneeded info.
    if (lines[lineNumber].startsWith("-")) {
      break;
    }
    lineNumber += 1;
  }

  // 4 is beacuse the line starts with '--- a'
  const oldFileRegex = /^--- \w*\/([a-zA-Z.\/]*)/
  const newFileRegex = /^\+\+\+ \w*\/([a-zA-Z.\/]*)/

  this.originalFileName = lines[lineNumber].match(oldFileRegex)[1]
  this.updatedFileName = lines[lineNumber + 1].match(newFileRegex)[1]
  lineNumber += 2;



  this.hunks = []
  let startHunk = lineNumber;
  for (let i = lineNumber + 1; i < lines.length; i++) {
    // if line contains hunk info create a new hunk;
    if (lines[i].match(diffHunkExpression) !== null) {
      this.hunks.push(new HunkDiff(lines.slice(startHunk, i)));
      startHunk = i;
    }
  }
  this.hunks.push(new HunkDiff(lines.slice(startHunk)));

  this.toString = function() {
    let string = `${this.originalFileName} -> ${this.updatedFileName}:\n`
    for (const hunk of this.hunks) {
      string += hunk.toString().replace(/^/gm, "\t");
    }
    return string;
  }
}

function HunkDiff(lines) {
  // Assumption the lines only contain one hunk;
  // this file contains the hunk info

  // Reset state
  diffHunkExpression.lastIndex = 0;
  const hunk_matches = diffHunkExpression.exec(lines[0])
  this.hunk_info = convertHunk(hunk_matches);

  //now the fun begins.
  this.lines = lines.slice(1);

  this.unchangedLines = []
  this.addedLines = []
  this.removedLines = []
  for (let i = 0; i < this.lines.length; i++) {
    const firstChar = this.lines[i][0];
    if (firstChar === "-") {
      this.removedLines.push(i);
    } else if (firstChar === "+") {
      this.addedLines.push(i);
    } else {
      this.unchangedLines.push(i);
    }
  }

  this.toString = function() {
    let string = `starting from original line number ${this.hunk_info.original_line} and spanning ${this.hunk_info.original_length}\n`;
    for (const line of this.lines) {
      string += `\t${line}\n`;
    }
    return string;
  }
}

function convertHunk(matches) {
  // takes a string in the format "-94,6 +94,59"
  return {
    original_line: parseInt(matches[1]),
    original_length: parseInt(matches[2]),
    updated_line: parseInt(matches[3]),
    updated_length: parseInt(matches[4])
  }
}

function logIn(username, password) {
  // basic
  octokit.authenticate({
    type: 'basic',
    username: username,
    password: password
  });
}

function getDefaultRepoOptionsFunction(owner, repo) {
  return function() {
    return {
      owner: owner,
      repo: repo,
    }
  }
}

// Util
function dynamicSort(property) {
  var sortOrder = 1;
  if (property[0] === "-") {
    sortOrder = -1;
    property = property.substr(1);
  }
  return function(a, b) {
    var result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
    return result * sortOrder;
  }
}

function processInputUrl(url) {
  const pullRequestRegex = /^https:\/\/github\.com\/(\w+)\/(\w+)\/pull\/(\d+)$/g;
  const baseRepoRegex = /^https:\/\/github\.com\/(\w+)\/(\w+)$/g;
  let matches = pullRequestRegex.exec(url);
  if (matches && matches.length === 4) {
    let owner = matches[1];
    let repository = matches[2];
    let prNumber = matches[3];
    const repo = new RepoWrapper(matches[1], matches[2]);

    repo.getPullRequest(prNumber).then((data) => {
      const name = data.title;
      const numChangedFiles = data.changed_files;
      const author = data.user.login;
      $('#pullRequestInfo').text(`${name} by ${author}. Number of changed files ${numChangedFiles}`);
    }).catch(() => {
      console.log("couldn't load PR " + prNumber)
      alert("Could not find/access url " + url);
    });

    repo.getPullRequestComments(prNumber).then((pullRequestComments) => {
      $('#comments').text(pullRequestComments.toString());
    }).catch(() => {
      console.log("couldn't load PR Comments" + prNumber);
    });

    repo.getPullRequestDiff(prNumber).then((pullRequestDiff) => {
      $('#diff').text(pullRequestDiff.toString());
    }).catch(() => {
      console.log("couldn't load PR Diff" + prNumber);
    });
  } else {
    alert("invalid url " + url);
  }
}

//After Dom Load
$(function() {
  $('#getPullRequestForm').on('submit', function() {
    var url = $('#pullRequest_url').val()
    processInputUrl(url);
    return false;
  });
});

// To simplify testing
const cerealNotesRepo = new RepoWrapper('atmiguel', 'cerealnotes')
let prObject
let prCommentsObject
let diffObject

cerealNotesRepo.getPullRequest(33).then((data) => {
  prObject = data;
});

cerealNotesRepo.getPullRequestComments(33).then((data) => {
  prCommentsObject = data;
});

cerealNotesRepo.getPullRequestDiff(33).then((data) => {
  diffObject = data;
});