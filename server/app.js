var net = require('net');
var inquirer = require("inquirer");
var dgram = require("dgram");
var mkdirp = require('mkdirp');
var fs = require('fs')
  , path = require('path');
var fs = require('fs-extra');
var files = 'mydatabase.sqlite';

//var clients = {};
//var files = {};

var cluster = require('cluster');
var numCPUs = require('os').cpus().length;

if (cluster.isMaster) {
    // Fork workers.
    for (var i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    Object.keys(cluster.workers).forEach(function(id) {
        console.log("I am running with ID : "+cluster.workers[id].process.pid);
    });

    cluster.on('exit', function(worker, code, signal) {
        console.log('worker ' + worker.process.pid + ' died');
    });
} else {

    //Do further processing.


    var server = net.createServer(function (socket) {
        var buffer = '';
        var clientRegistrationName = null;

        var getKeys = function (hash) {
            var keys = [];
            for (var key in hash) {
                keys.push(key);
            }

            return keys;
        };

        var sendError = function (description) {
            socket.write('ERR\nDESCRIPTION: ' + (description || ''));
        };

        var sendOk = function (description) {
            socket.write('OK\nDESCRIPTION: ' + (description || ''));
        };

        var processBuffer = function () {
            var index = buffer.indexOf('\n\n');


            if (index >= 0) {
                var request = buffer.substr(0, index);
                buffer = buffer.substr(index + '\n\n'.length);
                var lines = request.split('\n');
                if (lines.length < 1) {
                    return sendError('no command specified');
                }
                var command = lines[0].toLowerCase();
                var headers = {};
                for (var i = 1; i < lines.length; ++i) {
                    var line = lines[i];
                    var data = line.split(':');
                    if (data.length != 2) {
                        return sendError('invalid header ' + line);
                    }
                    headers[data[0].toLowerCase()] = data[1];
                }

                if (command === 'reg') {//registered

                    var clientName = headers.clientname;
                    var _udpPort = headers.udpport;
                    var _ip = socket.remoteAddress;


                    if (clientName === '') {
                        return sendError('client name can not be empty');
                    }
                    var sqlite3 = require('sqlite3').verbose();
                    var db = new sqlite3.Database(files);

                    db.serialize(function () {
                        var row;
                        //db.all("DELETE FROM client");
                        //db.all("DELETE FROM fileclient");
                        //db.all("DELETE FROM file");
                        db.all("SELECT * FROM client WHERE clientname = '" + clientName + "';", function (err, row) {
                            console.log(row);
                            if (row.length !== 0) {
                                //db.all("UPDATE client SET ip = " + _ip + " WHERE clientname = " + clientName);
                                db.run("DELETE FROM fileclient WHERE clientid = '" + clientName + "';");
                                db.run("UPDATE client SET ip = '" + _ip + "', udpPort = '" + _udpPort + "', count = " + 0 + " WHERE clientname = '" + clientName + "';");
                            }

                            if (row.length === 0) {
                                db.run("INSERT into client(clientname,udpPort,ip,count) VALUES ('" + clientName + "', '" + _udpPort + "', '" + _ip + "', '" + 0 + "');");
                            }

                        });
                    });
                    /* if (clients[clientName]) {//dlete file from same name client registred
                     var oldClientFiles = getKeys(clients[clientName].files);// s client nazashte budi :D
                     for (i = 0; i < oldClientFiles.length; ++i) {
                     var oldFile = oldClientFiles[i];

                     if (files[oldFile] && files[oldFile].clients[clientName]) {
                     var oldFileClients = files[oldFile].clients;
                     delete oldFileClients[clientName];

                     if (getKeys(oldFileClients).length < 1) {

                     delete files[oldFile];
                     }
                     }
                     }
                     }

                     clients[clientName] = {
                     files: {},
                     udpPort: udpPort,
                     ip: socket.remoteAddress,
                     count: 0
                     };*/

                    clientRegistrationName = clientName;

                    sendOk(clientName + ': registered successfully');

                    return;
                }

                if (command === 'get') { //download file

                    if (!clientRegistrationName) {
                        return sendError('not registered');
                    }

                    var filename = headers.filename;
                    var clientname = headers.clientname;
                    var ip = socket.remoteAddress;

                    var sqlite3 = require('sqlite3').verbose();
                    var db = new sqlite3.Database(files);

                    db.serialize(function () {
                        db.all("SELECT sha FROM file WHERE filename = '" + filename + "';", function (err, fileRow) {
                            db.all("SELECT clientid FROM fileclient WHERE fileid = '" + filename + "';", function (err, row) {
                                if (row.length === 0) {
                                    return sendError('not found');
                                }
                                console.log(row);
                                db.all("SELECT ip,udpPort FROM client WHERE clientname = '" +
                                    row[0].clientid + "';", function (err, cl) {

                                    if (cl.length === 0) {
                                        return sendError('no client found');
                                    }

                                    var ip = cl[0].ip;
                                    var port = cl[0].udpPort;
                                    var sha = fileRow[0].sha;

                                    socket.write('OK\n' + ip + ':' + port + ':' + sha);
                                });
                            });
                        });
                    });
                    /*if (!files[filename]) {
                     return sendError('not found file');
                     }

                     var ClientFiles = getKeys(files[filename].clients);
                     socket.write('OK\n' + clients[ClientFiles[0]].ip + ':' + clients[ClientFiles[0]].udpPort +
                     ':' + files[filename].sha
                     );*/

                    return;
                }


                if (command === 'lst') {//list

                    if (!clientRegistrationName) {
                        return sendError('not registered');
                    }

                    /*var str = '';
                     var ClientsFiles;
                     var counter = 0;
                     for (var i in files) {

                     ClientsFiles = getKeys(files[i].clients);
                     //console.log(ClientsFiles);
                     counter = counter + 1;
                     str = str + i.toString() + ':';
                     for (var j = 0; j < ClientsFiles.length; j++) {
                     str = str + ClientsFiles[j].toString() + ',';
                     }

                     str = str + '\n';

                     }
                     if (counter === 0) {
                     socket.write('the library is empty!!');
                     return;
                     }
                     else {
                     socket.write(str);*/
                    var file = 'mydatabase.sqlite';
                    var exists = fs.existsSync(file);
                    var sqlite3 = require("sqlite3").verbose();
                    var db = new sqlite3.Database(files);


                    db.serialize(function () {

                        db.all("SELECT * FROM  fileclient;", function (err, row) {
                            //console.log(row);
                            if (row.length !== 0) {
                                //console.log(row);
                                socket.write(JSON.stringify(row));
                                return;
                            }

                            if (row.length === 0) {
                                //console.log(row)
                                socket.write('the library is empty!!');
                                return;
                            }
                        });


                    });
                    return;
                }
            }

            if (command === 'put') {//upload
                if (!clientRegistrationName) {
                    return sendError('not registered');
                }

                var filename = headers.filename;
                var sha = headers.sha;

                if (!filename || !sha) {
                    return sendError('invalid put data, filename=' + filename + ', sha=' + sha);
                }


                /* if (!files[filename]) {
                 var fileClients = {};
                 fileClients[clientRegistrationName] = true;
                 files[filename] = {
                 clients: fileClients,
                 sha: sha
                 };
                 clients[clientRegistrationName].files[filename] = true;
                 clients[clientRegistrationName].count = clients[clientRegistrationName].count + 1;

                 sendOk('upload: '+ filename +' successfully');
                 return;
                 }

                 var file = files[filename];

                 if (file.clients[clientRegistrationName]) {
                 return sendError('duplicate client file upload ' + filename);
                 }

                 if (file.sha !== sha) {
                 return sendError('bad sha, not what expected=' + sha);
                 }

                 file.clients[clientRegistrationName] = true;
                 clients[clientRegistrationName].files[filename] = true;
                 clients[clientRegistrationName].count = clients[clientRegistrationName].count + 1;

                 sendOk('upload' + filename + 'successfully ');
                 return;
                 }*/

                var sqlite3 = require("sqlite3").verbose();
                var db = new sqlite3.Database(files);
                var row;
                var sum;
                var counter;
                db.serialize(function () {
                    db.all("SELECT clientid FROM fileclient WHERE fileid = '" + filename + "';", function (err, row) {

                        db.all("SELECT count FROM client WHERE clientname = '" + clientRegistrationName + "';", function (err, counter) {
                            var _sum = JSON.stringify(counter[0]["count"]);
                            sum = Number(_sum);
                            console.log(sum);
                            sum = sum + 1;
                            //console.log(sum);


                            if (row.length === 0) {

                                db.run("INSERT into fileclient(fileid,clientid) VALUES ('" + filename + "', '" + clientRegistrationName + "');");

                                db.all("SELECT * FROM file WHERE filename = '" + filename + "';", function (err, row) {
                                    if (row.length !== 0) {
                                        return db.run("UPDATE file SET sha = '" + sha + "' WHERE filename = '" + filename + "';");
                                    }
                                    db.run("INSERT into file(filename,sha) VALUES ('" + filename + "', '" + sha + "');");
                                });
                                db.run("UPDATE client SET count = '" + sum + "' WHERE clientname = '" + clientRegistrationName + "';");

                                console.log('number of upload: ' + sum);
                                sendOk('upload ' + filename + ' successfully');
                                return;

                            }


                            if (row.length !== 0) {
                                for (var i = 0; i < row.length; i++) {
                                    console.log(row[i]["clientid"]);
                                    if (row[i]["clientid"] === clientRegistrationName) {
                                        sendError('duplicate client file upload ' + filename);
                                        return;
                                    }
                                }


                                db.all("SELECT * FROM file WHERE filename = '" + filename + "';", function (err, shasum) {

                                    if (shasum[0]["sha"] !== sha) return sendError('bad sha, not what expected= ' + sha);
                                });


                                db.run("INSERT into fileclient(fileid,clientid) VALUES ('" + filename + "', '" + clientRegistrationName + "');");
                                db.run("UPDATE client SET count = '" + sum + "' WHERE clientname = '" + clientRegistrationName + "';");
                                console.log('number of upload: ' + sum);

                                return sendOk('upload' + filename + 'successfully ');
                            }
                        });
                    });

                });

                processBuffer();
            }
        };

        socket.on('error', function (err) {
            console.error('\n\nSOCKET ERROR:\n', err);
        });
        socket.write('Hello, client!Server.\r\n');
        socket.on('data', function (data) {
            data = data.toString();

            if (data.length > 1024) {
                data = data.substr(data.length - 1024);
            }

            buffer = buffer + data;

            if (buffer.length > 1024) {
                buffer = buffer.substr(buffer.length - 1024);
            }

            processBuffer();
        });
    });

    server.listen(879, '0.0.0.0');
}