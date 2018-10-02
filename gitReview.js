'use strict'

const octokit = new Octokit()

function Comment(response) {
    this.author = response.user.login
    this.content = response.body
    this.filename = response.path
    this.id = response.id
    this._originalResponse = response
    this.child = undefined

    var raw_hunk_info = response.diff_hunk.substr(response.diff_hunk.indexOf("@@ "), response.diff_hunk.indexOf(" @@"));
    var hunk_info = convertHunk(raw_hunk_info);
    // the original_position is 1 based
    this.lineNumber = hunk_info.updated_line + response.original_position -1;
}

function RepoWrapper(owner, repo) {
    this.getDefaultOptions = getDefaultRepoOptionsFunction(owner, repo)
    this.getPullRequestComments = function(pullNumber) {
        const opts = this.getDefaultOptions();
        opts.number = pullNumber;
        opts.per_page = 100
        return octokit.pullRequests.getComments(opts).then(({data, headers, status}) => {
            if (status !== 200) {
                console.log(data);
                console.log(headers);
                throw "Something went wrong";
            }
            // Sorting gurantees we see parents before we see children comments
            return organizeComments(data.sort(dynamicSort("created_at")));
            });
        };
}

function PullReviewComments(){
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
        if (threads === undefined){
            threads = new Array();
            val.set(lineNumber, threads);
        }

        return threads;
    };

    this.addCommentToThreads = function(threads, comment){
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
            // both the reply and the reply to the reply have the same in_reply_to_id object
            if (iterComment.id === commentParentId && iterComment.child === undefined) {
                iterComment.child = comment;
                return true;
            }

            iterComment = iterComment.child;
        }

        return false;
    };

    this.string = function() {
        let string = "";
        let totalComments = 0
        this.filesToLinnumberToCommentThread.forEach((lineNumberToComments, file) => {
            string += `${file}\n`;
            lineNumberToComments.forEach((threads, lineNumber) => {
                threads.forEach((commentThread) => {
                    string += `\t${lineNumber}:\n`;
                    let commentIter = commentThread;
                    while (commentIter !== undefined) {
                        totalComments+=1;
                        string += `\t\t${commentIter.author}: ${commentIter.content}\n`;
                        commentIter = commentIter.child;
                    }
                });
            });
        });

        console.log("total comments" + totalComments)
        return string;
    };
}

function convertHunk(str) {
    // takes a string in the format "@@ -94,6 +94,59 @@"
    let vals = str.split(" ")

    let original = vals[1]
    let updated = vals[2]

    return {
        original_line: parseInt(original.split(",")[0].substr(1)),
        original_length: parseInt(original.split(",")[1]),
        updated_line: parseInt(updated.split(",")[0].substr(1)),
        original_length: parseInt(updated.split(",")[1])
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
    return function(){
        return {
            owner: owner,
            repo: repo,
        }
    }
}

function organizeComments(rawCommentArray){
    const commentsByFileNameByLine = new PullReviewComments();
    rawCommentArray.forEach( function (rawComment) {
        commentsByFileNameByLine.addRawComment(rawComment);
    });
    return commentsByFileNameByLine;
}



// Util
function dynamicSort(property) {
    var sortOrder = 1;
    if(property[0] === "-") {
        sortOrder = -1;
        property = property.substr(1);
    }
    return function (a,b) {
        var result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
        return result * sortOrder;
    }
}

// To simply testing
const cerealNotesRepo = new RepoWrapper('atmiguel', 'cerealnotes')
cerealNotesRepo.getPullRequestComments(39).then((data) => {
    let str = data.string();
    $('#comments').text(str);
});