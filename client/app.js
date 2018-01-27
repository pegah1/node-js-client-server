//var argv = require('minimist')(process.argv.slice(2));

var net = require('net');
var client = new net.Socket();
var socket, port, ClientName;
var inquirer = require("inquirer");
var dgram = require("dgram");
var mkdirp = require('mkdirp');
var fs = require('fs')
    , path = require('path');
var async = require('async');
var sha = require('sha256');
var uploadFolder, downloadFolder;

var UDP_PACKET_SIZE = 256;
var UDP_PART_PACKETS = 5;
var isDownloadingFile = false;

var fileDescriptor = {};
var openFile = function (filename, callback) {
  if (!fileDescriptor[filename]) {
      return fs.open(filename, 'r', function (err, fd) {
          if (err) {
              return callback(err);
          }
          fileDescriptor[filename] = fd;
          return callback(null, fd);
      });
  }
    return callback(null, fileDescriptor[filename]);
};

var lastStatisticTime = 0;
var statisticUploadedBytes = 0;
var statisticDownloadedBytes = 0;
var statisticAdd = function (bytesUploaded, bytesDownloaded) {
    var currentTime = (new Date()).getTime();
  statisticUploadedBytes += bytesUploaded;
    statisticDownloadedBytes += bytesDownloaded;

    if ((currentTime - lastStatisticTime) >= 2000) {
        var dt = currentTime - lastStatisticTime;
        lastStatisticTime = currentTime;
        var uploadSpeed = Math.floor((statisticUploadedBytes / 1024) / (dt / 1000)); //KB/s
        var downloadSpeed = Math.floor((statisticDownloadedBytes / 1024) / (dt / 1000)); //KB/s
        statisticDownloadedBytes = statisticUploadedBytes = 0;
        var log = 'Upload Speed: ' + uploadSpeed + ' KB/s, Download Speed: ' + downloadSpeed + ' KB/s';
        console.log(log);
    }
};

var logError = function (err) {
    return console.log(err.stack ? err.stack : (err.toString ? err.toString() : (JSON.stringify(err))));
};

var calculateSha = function (fileName, callback) {

    return fs.open(fileName, 'r', function (err, fd) {
        if (err) {
            return callback(err);
        }
        var calculatedSha = new Buffer(0);
        var buffer = new Buffer(256);
        var position = 0;

        var readNextPart = function () {
            return fs.read(fd, buffer, 0, 256, position, function (err, bytesRead, part) {
                if (err) {
                    return callback(err);
                }

                calculatedSha = Buffer.concat([calculatedSha, part]);
                var arr = [];
                for (var i = 0; i < calculatedSha.length; ++i) {
                    arr[i] = calculatedSha[i];
                }
                calculatedSha = new Buffer(sha(arr, {asBytes: true}));
                position = position + bytesRead;

                if (bytesRead < 256) {
                    return callback(null, calculatedSha);
                }
                    return readNextPart();
            });
        };
        return readNextPart();
    });
};

var sendGetFileInfo = function (socket, destinationHost, destinationPort, fileName) {
    var encodedFileName = new Buffer(fileName);
    var encodedFileNameLength = Buffer.byteLength(fileName);
    var buffer = new Buffer(1);
    buffer.writeUInt8(0x01);

    var concatBuffer = Buffer.concat([buffer, encodedFileName]);
    var concatBufferLength = 1 + encodedFileNameLength;
    socket.send(concatBuffer, 0, concatBufferLength, destinationPort, destinationHost);
};

var sendGetFileInfoResponse = function (socket, destinationHost, destinationPort, fileName) {
    return fs.stat(fileName, function (err, stat) {
        var fileSize;
        var numberOfParts;

        if (err) {
            fileSize = 0xFFFFFFFF;
            numberOfParts = 0xFFFFFFFF;
        } else {
            fileSize = stat.size;
            numberOfParts = Math.ceil(fileSize / (UDP_PACKET_SIZE * UDP_PART_PACKETS));
        }

        var buffer = new Buffer(9);
        buffer.writeUInt8(0x02, 0);
        buffer.writeUInt32LE(fileSize, 1);
        buffer.writeUInt32LE(numberOfParts, 5);

        socket.send(buffer, 0, 9, destinationPort, destinationHost);
    });
};

var sendRequestPart = function (socket, destinationHost, destinationPort, fileName, partNumber,
                                transmissionId, firstSequenceNumber) {

    var buffer = new Buffer(11 + Buffer.byteLength(fileName));
    buffer.writeUInt8(0x04, 0);
    buffer.writeUInt32LE(partNumber, 1);
    buffer.writeUInt16LE(transmissionId, 5);
    buffer.writeUInt32LE(firstSequenceNumber, 7);
    buffer.write(fileName, 11);

    socket.send(buffer, 0, 11 + Buffer.byteLength(fileName), destinationPort, destinationHost);
};

var sendRequestPartError = function (socket, destinationHost, destinationPort, transmissionId, reason) {
    var bufferSize = 3 + Buffer.byteLength(reason);

    reason = reason.stack ? reason.stack : (
        reason.toString ? reason.toString() : (
            JSON.stringify(reason)
        )
    );

    var buffer = new Buffer(bufferSize);
    buffer.writeUInt8(0x08, 0);
    buffer.writeUInt16LE(transmissionId, 1);
    buffer.write(reason, 3);

    socket.send(buffer, 0, bufferSize, destinationPort, destinationHost);
};

var sendPart = function (socket, destinationHost, destinationPort, sequenceNumber, transmissionId,
                         lastPacket, data, dataLength) {
    var bufferSize = 7;
    var flags = 0x10;

    if (lastPacket) {
        flags = flags | 0x20;
    }

    var buffer = new Buffer(bufferSize);
    buffer.writeUInt8(flags, 0);
    buffer.writeUInt32LE(sequenceNumber, 1);
    buffer.writeUInt16LE(transmissionId, 5);

    var concatBufferSize = bufferSize + dataLength;
    var concatBuffer = Buffer.concat([buffer, data]);

    socket.send(concatBuffer, 0, concatBufferSize, destinationPort, destinationHost);
};

var parseIncomingPacket = function (msg, rinfo) {
    var result = {
        sourceHost: rinfo.address,
        sourcePort: rinfo.port
    };

    var flags = msg.readUInt8(0);

    if (flags & 0x01) {
        result.operation = 'GET_FILE_INFO';
        result.fileName = msg.toString('utf8', 1);
    } else if (flags & 0x02) {
        result.operation = 'GET_FILE_INFO_RESPONSE';
        result.fileSize = msg.readUInt32LE(1);
        result.numberOfParts = msg.readUInt32LE(5);
    } else if (flags & 0x04) {
        result.operation = 'REQUEST_PART';
        result.partNumber = msg.readUInt32LE(1);
        result.transmissionId = msg.readUInt16LE(5);
        result.firstSequenceNumber = msg.readUInt32LE(7);
        result.fileName = msg.toString('utf8', 11);
    } else if (flags & 0x08) {
        result.operation = 'REQUEST_PART_ERROR';
        result.transmissionId = msg.readUInt16LE(1);
        result.reason = msg.toString('utf8', 3);
    } else if (flags & 0x10) {
        result.operation = 'PART';
        result.sequenceNumber = msg.readUInt32LE(1);
        result.transmissionId = msg.readUInt16LE(5);
        result.data = msg.slice(7);
        result.isLastPacket = false;

        if (flags & 0x20) {
            result.isLastPacket = true;
        }
    } else {
        throw new Error('unrecognized packet with flags ' + flags);
    }

    return result;
};

var UDP_TIMEOUT =  2 * 1000; //2 * 60 * 1000;
var currentDownloadFileName;
var currentDownloadFileHost;
var currentDownloadFilePort;
var currentDownloadFileSize;
var currentDownloadFileNumberOfParts;
var currentDownloadTransmissionId = 0;
var currentDownloadCallback;
var currentDownloadPackets = {};
var currentDownloadTimeId = 0;
var currentDownloadSeenLast;
var currentDownloadPart;
var currentDownloadFd;
var currentDownloadSha;

var startDownloadingFile = function (host, port, fileName, callback) {
    currentDownloadFileName = fileName;
    currentDownloadFileHost = host;
    currentDownloadFilePort = port;

    var transmissionId = currentDownloadTransmissionId = currentDownloadTransmissionId + 1;
    currentDownloadCallback = callback;
    currentDownloadFileSize = -1;
    currentDownloadFileNumberOfParts = -1;

    setTimeout(function () {
        if (currentDownloadTransmissionId === transmissionId &&
            (currentDownloadFileSize < 0 || currentDownloadFileNumberOfParts < 0)) {
            return callback('FILE INFO REQUEST TIMEOUT');
        }
    }, UDP_TIMEOUT);

    return sendGetFileInfo(socket, host, port, fileName);
};

var openUdpSocket = function (callback) {

    var createDownloadTimeoutTimer = function (callback) {
        var id = currentDownloadTimeId;

        setTimeout(function () {
            if (id === currentDownloadTimeId) {
                return callback("connection timeout!");
            }
        }, UDP_TIMEOUT);
    };

    var downloadRequestNextPart = function () {
        var currPart = currentDownloadPart = currentDownloadPart + 1;
        currentDownloadTimeId = currentDownloadTimeId + 1;

        if (currentDownloadPart >= currentDownloadFileNumberOfParts) {
            return fs.close(currentDownloadFd, function () {

                return calculateSha(path.join(downloadFolder, currentDownloadFileName), function (err, calcSha) {
                    if (err) {
                        return logError(err);
                    }

                    calcSha = calcSha.toString('hex');

                    if (calcSha !== currentDownloadSha) {
                        return currentDownloadCallback('SHA COMPARE FAILED. RETRY-ING...');
                    }
                    return currentDownloadCallback("Download Completed Successfuly!");
                });
            });
        }

        currentDownloadPackets = {};
        currentDownloadSeenLast = false;

        createDownloadTimeoutTimer(function () {
            currentDownloadPart = currPart - 1;
            console.log('+++ No-Packet, Re-Trying part ' + currPart);
            return downloadRequestNextPart();
        });

        //console.log('> requesting part: ' + (currentDownloadPart+1) + '/' + currentDownloadFileNumberOfParts);

        return sendRequestPart(socket, currentDownloadFileHost, currentDownloadFilePort,
            currentDownloadFileName, currentDownloadPart, currentDownloadTransmissionId,
            0);
    };


    var udp_port = Math.floor(Math.random() * 65534 + 1); //BUGFIX

    var server = dgram.createSocket("udp4");

    server.on("error", function (err) {
        console.log("server error:\n" + err.stack);
        server.close();

        return setTimeout(function () {
            return udp_port(callback);
        }, 0);
    });

    server.on("listening", function () {
        var address = server.address();

        console.log("server listening " + address.address + ":" + address.port);

        socket = server;

        return callback(server, udp_port);
    });

    server.on("message", function (msg, rinfo) {
        var packet = parseIncomingPacket(msg, rinfo);

        if (packet.operation === "GET_FILE_INFO") {
            return sendGetFileInfoResponse(server, packet.sourceHost, packet.sourcePort,
                path.join(uploadFolder, packet.fileName));
        } else if (packet.operation === "REQUEST_PART") {
            return fs.stat(path.join(uploadFolder, packet.fileName), function (err, stat) {
                if (err) {
                    return sendRequestPartError(server,
                        packet.sourceHost,
                        packet.sourcePort,
                        packet.transmissionId,
                        err.stack ? err.stack : (err.toString ? err.toString() : JSON.stringify(err))
                    );
                }

                var fileSize = stat.size;
                var numberOfParts = Math.ceil(fileSize / (UDP_PACKET_SIZE * UDP_PART_PACKETS));

                return openFile(path.join(uploadFolder, packet.fileName), function (err, fd) {
                    if (err) {
                        return sendRequestPartError(server, packet.sourceHost, packet.sourcePort,
                            packet.transmissionId,
                        err || 'can not open file for reading!');
                    }

                    var tasks = [];
                    for (var i = 0; i < UDP_PART_PACKETS; ++i) {
                        tasks.push(i);
                    }

                    async.each(tasks, function (i, callback) {
                        var buffer = new Buffer(UDP_PACKET_SIZE);
                        var position = packet.partNumber * (UDP_PACKET_SIZE * UDP_PART_PACKETS) +
                            i * UDP_PACKET_SIZE;

                        if (position < stat.size) {

                            var lastPacket = false;
                            if (i + 1 === UDP_PART_PACKETS) {
                                lastPacket = true;
                            }

                            return fs.read(fd, buffer, 0, UDP_PACKET_SIZE, position, function (err, bytesRead) {
                                if (err || !bytesRead) {
                                    fs.close(fd);
                                    return sendRequestPartError(server, packet.sourceHost, packet.sourcePort,
                                        packet.transmissionId, err || 'cant read bytes from position ' + position);
                                }

                                if (bytesRead !== UDP_PACKET_SIZE) {
                                    lastPacket = true;
                                }
                                statisticAdd(bytesRead, 0);

                                sendPart(server, packet.sourceHost, packet.sourcePort,
                                    packet.firstSequenceNumber + i, packet.transmissionId, lastPacket,
                                    buffer, bytesRead);
                                return callback();
                            });
                        }
                    }, function (err) {
                    });
                });
            });
        } else if (packet.operation === "GET_FILE_INFO_RESPONSE") {
            currentDownloadFileSize = packet.fileSize;
            currentDownloadFileNumberOfParts = packet.numberOfParts;

            if (currentDownloadFileSize === 0xFFFFFFFF || currentDownloadFileNumberOfParts === 0xFFFFFFFF
                || currentDownloadFileSize < 0 || currentDownloadFileNumberOfParts < 0
            ) {
                currentDownloadFileSize = currentDownloadFileNumberOfParts = 0;
                return currentDownloadCallback("Request file info failed!");
            }

            return fs.open(path.join(downloadFolder, currentDownloadFileName), "w", function (err, fd) {
                if (err) {
                    return currentDownloadCallback("can not open output file");
                }

                currentDownloadPart = -1;
                currentDownloadFd = fd;
                return downloadRequestNextPart();
            });
        }
        else if (packet.operation === "REQUEST_PART_ERROR") {
            console.log("can not obtain part from server, reason: " + packet.reason);
            currentDownloadTimeId = currentDownloadTimeId + 1;
            return setTimeout(function () {
                currentDownloadPart = currentDownloadPart - 1;
                return downloadRequestNextPart();
            }, 10000);
        }
        else if (packet.operation === "PART") {
            statisticAdd(0, packet.data.length);
            currentDownloadPackets[packet.sequenceNumber] = packet.data;
            currentDownloadTimeId = currentDownloadTimeId + 1;
            var currPart = currentDownloadPart;
            createDownloadTimeoutTimer(function () {
               currentDownloadPart = currPart - 1;
                console.log('--- Packet loss, Re-Trying part ' + currPart);
                return downloadRequestNextPart();
            });

            if (!currentDownloadSeenLast) {
                currentDownloadSeenLast = packet.isLastPacket;
            }
            if (currentDownloadSeenLast) {
                var keys = [];
                var maxKey = -1;
                for (var key in currentDownloadPackets) {
                    keys.push(key);
                    if (key > maxKey) {
                        maxKey = key;
                    }
                }

                if (keys.length == (Number(maxKey) + 1)) {
                    var tasks = [];
                    for (var i = 0; i <= maxKey; ++i) {
                        tasks.push(i);
                    }

                    async.eachSeries(tasks, function (i, callback) {
                        var p = currentDownloadPackets[i];

                        return fs.write(currentDownloadFd, p, 0, p.length,
                            function (err, written) {
                                if (err) {
                                    return currentDownloadCallback("can not write to disk");
                                }

                                return callback();
                            });
                    }, function (err) {
                        return downloadRequestNextPart();
                    });
                }


            }
        }
    });

    try {
        server.bind(udp_port);
    } catch (e) {
        server.close();
        return setTimeout(function () {
            return udp_port(callback);
        }, 0);
    }
};


var promptFunc = function () {

    var preguntas = [
        {
            type: "list",
            name: "estudios",
            message: "choose the process:",
            choices: [
                "1.REGISTER",
                "2.UPLOAD FILE",
                "3.DOWNLOAD FILE",
                "4.LIST OF FILE",
                "5.EXIT"
            ]
        }
    ];

    inquirer.prompt(preguntas, function (reply) {
        var rep;
        for (var i in reply) {
            rep = reply[i];
        }

        if (rep === preguntas[0].choices[0]) {//register

            var input_register = [
                {
                    type: 'input',
                    name: 'clientName:',
                    message: 'Enter ClientName:'
                    //default: 'field is empty!!'
                }
            ];

            inquirer.prompt(input_register, function (in_reg) {

                for (var i in in_reg) {
                    ClientName = in_reg[i];
                }
                openUdpSocket(function (socket, port) {
                    client.write('reg\nclientname:' + ClientName + '\nudpPort:' + port + '\n\n');
                    var mkdirpSync = function (dirpath) {
                        var parts = dirpath.split(path.sep);
                        for (var i = 1; i <= parts.length; i++) {
                            fs.mkdirSync(path.join.apply(null, parts.slice(0, i)));
                        }
                    }

                    var dir_path = 'clients/' + ClientName;
                    downloadFolder = 'clients/' + ClientName + '/download';
                    uploadFolder = 'clients/' + ClientName + '/upload';

                    if (!fs.existsSync(dir_path)) {
                        mkdirpSync('clients/' + ClientName);
                        mkdirpSync(downloadFolder);
                        mkdirpSync(uploadFolder);
                    }
                });

            });
            return;
        }


        if (rep === preguntas[0].choices[1]) {//upload
            var input_up = [
                {
                    type: 'input',
                    name: 'fileName:',
                    message: 'Enter fileName:'
                    //default: 'field is empty!!'
                }
            ];

            inquirer.prompt(input_up, function (in_up) {
                var filename;
                for (var i in in_up) {
                    filename = in_up[i];
                }

                /* if (!fs.existsSync(path.join(uploadFolder, filename))) {//ezafe kardam
                 console.log('not upload file!!');

                 }*/

                return calculateSha(path.join(uploadFolder, filename), function (err, calcSha) {
                    if (err) {
                        return logError(err);
                    }

                    calcSha = calcSha.toString('hex');
                    console.log('HASH IS:', calcSha);

                    client.write('put\nfilename:' + filename + '\nsha:' + calcSha + '\n\n');
                });

            });
            return;
        }
        ;


        if (rep === preguntas[0].choices[2]) {//download
            var input_dl = [
                {
                    type: 'input',
                    name: 'fileName:',
                    message: 'Enter fileName:'
                    //default: 'field is empty!!'
                }
            ];

            inquirer.prompt(input_dl, function (in_dl) {
                var fileName;
                for (var i in in_dl) {
                    fileName = in_dl[i];
                }
                currentDownloadFileName = fileName;
                client.write('get\nfilename:' + fileName + '\nclientname:' + ClientName + '\n\n');
                isDownloadingFile = true;
            });

            return;
        }


        if (rep === preguntas[0].choices[3]) {//list
            console.log('\n');
            client.write('lst\n\n');
            return;
        }
        if (rep === preguntas[0].choices[4]) {//exit
            console.log('\n');
            return;
        }

        promptFunc();
    });

};

client.connect(879, '127.0.0.1', function () {

});

client.on('data', function (data) {

    console.log(data + '\n');

    if (isDownloadingFile) {
        isDownloadingFile = false; //BUGFIX
        data = data.toString();
        var index = data.indexOf("\n");
        if (data.substr(0, index) !== 'OK') {
            return console.log('Error getting hosting client information: ' + data);
        }
        data = data.substr(index + '\n'.length);
        ;
        index = data.indexOf(':');
        var ip = data.substr(0, index).trim();
        data = data.substr(index + 1);
        index = data.indexOf(':');
        var port = data.substr(0, index).trim();
        currentDownloadSha = data.substr(index + 1).trim();
        startDownloadingFile(ip, port, currentDownloadFileName, function (err) {
            console.log(err);
            promptFunc();
        });
    }
    else {
        promptFunc();
    }
});

client.on('error', function (err) {
    console.error('\n\nSOCKET ERROR:\n', err);
});

