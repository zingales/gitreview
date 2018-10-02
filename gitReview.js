'use strict'

const octokit = new Octokit()

function Comment(response) {
    this.author = response.user.login
    this.content = response.body
    this.filename = response.path
    this.lineNumber = response.original_position
    this.id = response.id
    this._originalResponse = response
    this.child = undefined
}

function RepoWrapper(owner, repo) {
    this.getDefaultOptions = getDefaultRepoOptionsFunction(owner, repo)
    this.getPullRequestComments = function(pullNumber) {
        const opts = this.getDefaultOptions();
        opts.number = pullNumber;
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
            if (iterComment.id === commentParentId) {
                if (iterComment.child !== undefined) {
                    throw "I Already have a child";
                }

                iterComment.child = comment;
                return true;
            }

            iterComment = iterComment.child;
        }

        return false;
    };

    this.string = function() {
        let string = "";
        this.filesToLinnumberToCommentThread.forEach((lineNumberToComments, file) => {
            string += `${file}\n`;
            console.log(lineNumberToComments);
            // debugger
            lineNumberToComments.forEach((threads, lineNumber) => {
                threads.forEach((commentThread) => {
                    string += `\t${lineNumber}:\n`;
                    let commentIter = commentThread;
                    // console.log(commentThread);
                    while (commentIter !== undefined) {
                        string += `\t\t${commentIter.author}: ${commentIter.content}\n`;
                        commentIter = commentIter.child;
                    }
                });
            });
        });

        return string;
    };
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

function assignLineage(newComment, originalComment) {
    if (originalComment === undefined){
        return newComment
    }

    let newCommentParentId = newComment._originalResponse.in_reply_to_id;
    let oringalCommentParentId = originalComment._originalResponse.in_reply_to_id;

    if (newCommentParentId === undefined && oringalCommentParentId === undefined){
        throw ("both comments don't think they have any parentage", newComment, originalComment);
    }

    if (newCommentParentId !== undefined) {
        let idToFind = newCommentParentId;
        let iterComment = originalComment;
        while (iterComment !== undefined) {
            if (iterComment.id === newCommentParentId){
                if (originalComment.child !== undefined) {
                    throw ("comment alredy has child", originalComment, newCommentParentId);
                }

                iterComment.child = newComment;
                return originalComment;
            }

            iterComment = iterComment.child;
        }

        throw ("could not find parent")
    }

    if (oringalCommentParentId === newComment.id) {
        newComment.child = originalComment;
        return newComment;
    }

    throw ("something went wrong");
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