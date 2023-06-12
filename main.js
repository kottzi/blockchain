'use strict'; // Строгий режим
var CryptoJS = require("crypto-js"); // Для создания хэшей блоков
var express = require("express"); // Для обработки HTTP-запросов; взаимодействие с блокчейном
var bodyParser = require('body-parser'); // Используется вместе с Express для чтения HTTP POST данных. Он преобразует входящие запросы в удобный для использования формат
var WebSocket = require("ws"); // Используется для взаимодействия с другими узлами в сети по протоколу WebSocket
var Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_ !?.,/:;[{}]+-=<>0123456789"; // Строковая переменная, содержащая алфавит

// Установка портов
var http_port = process.env.HTTP_PORT|| 3001;
var p2p_port = process.env.P2P_PORT|| 6001;
// Peer-to-Peer, это тип сетевой архитектуры, где каждый узел (peer) сети может взаимодействовать напрямую с другими узлами без необходимости проходить через центральный сервер

// Инициализация списка пиров (других узлов в сети)
var initialPeers = process.env.PEERS? process.env.PEERS.split(',') : [];
// Установка сложности
var difficulty= 2;

// Класс создания блока
class Block {
    constructor(index, previousHash, timestamp, data, hash, difficulty, nonce) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.hash= hash.toString();
        this.difficulty = difficulty;
        this.nonce = nonce;
    }
}

// Инициализация пустого массива для хранения подключенных сокетов (узлов/пиров)
var sockets = [];
// Констанции для различных видос сообщений, которые будут передаваться между узлами
var MessageType = {
    QUERY_LATEST:0,
    QUERY_ALL:1,
    RESPONSE_BLOCKCHAIN:2
};

// Получение генезис-блока
var getGenesisBlock = () => {
    return new Block(0, "0", 1682839690, "RUT-MIIT first block", "8d9d5a7ff4a78042ea6737bf59c772f8ed27ef3c9b576eac1976c91aaf48d2de", 0, 0);
};

// Инициализация блокчейна с генезис-блоком
var blockchain = [getGenesisBlock()];

// Инициализация HTTP-сервера
var initHttpServer = () => {
    var app = express(); // Инициализация сервера, который будет прослушивать входящие HTTP-запросы
    app.use(bodyParser.json()); // Для преобразования тела запроса в JSON, который легко обрабатывать в JavaScript

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain))); // Получение всех блоков
    app.post('/mineBlock', (req, res) => { // Добавление нового блока
        var newBlock= mineBlock(req.body.data);
        addBlock(newBlock);
        broadcast(responseLatestMsg());
        console.log('block added: '+ JSON.stringify(newBlock));res.send();
    });
    app.get('/peers', (req, res) => { // Возвращение списка пиров
        res.send(sockets.map(s=>s._socket.remoteAddress+ ':'+ s._socket.remotePort));
    });
    app.post('/addPeer', (req, res) =>{ // Добавление нового пира
        connectToPeers([req.body.peer]);
        res.send();
    });
    app.listen(http_port, () => console.log('Listening http on port: '+ http_port)); // Запуск HTTP-сервера
};

var mineBlock = (blockData) => {
    var previousBlock= getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nonce = 0;
    var nextTimestamp = new Date().getTime() / 1000;
    var nextHash= calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData, nonce);

    while (nextHash.indexOf('b0b') == -1) // more chars
    {
        nonce++;
        nextTimestamp = new Date().getTime() / 1000;
        nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData, nonce)
        console.log("\"index\":" + nextIndex + ",\"previousHash\":" + previousBlock.hash + "\"timestamp\":" + 
            nextTimestamp + ",\"data\":"+blockData+",\x1b[33mhash: " + nextHash + 
            " \x1b[0m," + "\"difficulty\":"+difficulty + " \x1b[33mnonce: " + nonce + " \x1b[0m ");
    }
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash, difficulty, nonce);
}

// Инициализация P2P-сервера
var initP2PServer = () => {
    var server= new WebSocket.Server({port:p2p_port}); // Инициализация сервера, который будет прослушивать входящие веб-сокеты
    server.on('connection', ws=>initConnection(ws)); // При подключении нового узла, инициализируем новое подключение
    console.log('listening websocket p2p port on: '+ p2p_port);
};

// Инициализация нового подключения (между websocket-сервером и другим узлом)
var initConnection = (ws) => {
    sockets.push(ws); // Добавляем новый сокет в массив сокетов
    initMessageHandler(ws); // Инициализируем обработчик сообщений для каждого нового подключения
    initErrorHandler(ws); // Инициализируем обработчик ошибок для каждого нового подключения
    write(ws, queryChainLengthMsg()); // При подключении нового узла, отправляем ему запрос на получение длины цепочки блоков
};

// Инициализация обработчика сообщений
var initMessageHandler = (ws) => {
    ws.on('message', (data) => { // При получении сообщения
        var message= JSON.parse(data); // Парсим сообщение в JSON
        console.log('Received message'+ JSON.stringify(message));
        switch(message.type) { // В зависимости от типа сообщения, выполняем различные действия
            case MessageType.QUERY_LATEST:write(ws, responseLatestMsg()); // Если запрос на последний блок
            break;
            case MessageType.QUERY_ALL:write(ws, responseChainMsg()); // Если запрос на всю цепочку блоков
            break;
            case MessageType.RESPONSE_BLOCKCHAIN:handleBlockchainResponse(message); // Если получена цепочка блоков
            break;
        }
    });
};

// Инициализация обработчика сообщений
var initErrorHandler = (ws) => {
    var closeConnection = (ws) => { // При закрытии соединения
        console.log('connection failed to peer: '+ ws.url);
        sockets.splice(sockets.indexOf(ws), 1); // Удаляет подключение WebSocker из массива sockets
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () =>closeConnection(ws));
};

// Подключение к новым пирам
var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {console.log('connection failed')});
    });
};

// Обработка ответа блокчейна (обработка входящего сообщение RESPONSE_BLOCKCHAIN)
var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index-b2.index)); // Получаем цепочку блоков
    var latestBlockReceived = receivedBlocks[receivedBlocks.length-1]; // Получаем последний блок
    var latestBlockHeld = getLatestBlock(); // Получаем последний блок из нашей локальной цепочки блоков

    if (latestBlockReceived.index > latestBlockHeld.index) { // index - это номер блока в цепочке блоков
        console.log('blockchain possibly behind. We got: '+ latestBlockHeld.index + ' Peer got: '+ latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) { // Если хэш последнего блока нашей цепочки совпадает с хэшем предыдущего блока полученной цепочки
            console.log("We can append the received block to our chain"); 
            blockchain.push(latestBlockReceived); // Добавляем полученный блок в нашу цепочку
            broadcast(responseLatestMsg()); // Отправляем всем узлам сообщение о том, что у нас появился новый блок
        } 
        else if (receivedBlocks.length === 1) { // Если получен новый блок от пира, но он не является продолжением нашей цепочки
            console.log("We have to query the chain from our peer");
            broadcast(queryAllMsg()); // Запрашиваем у пира всю его цепочку блоков
        } 
        else { // Иначе
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks); // Заменяем нашу цепочку на полученную
        }
    } 
    else {
        console.log('received blockchain is not longer than current blockchain. Do nothing');
    }
};

// Генерация следующего блока
var generateNextBlock = (blockData) => {
    var previousBlock= getLatestBlock(); // Ссылка на последний блок в цепочке
    var nextIndex = previousBlock.index + 1; // Номер следующего блока
    var nextTimestamp = new Date().getTime() / 1000; // Время создания следующего блока
    var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData);
    // Хэш следующего блока из объединения всех его данных

    return new Block (nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash);
};

// Расчёт хэша для блока
var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data, block.nonce);
};

// Изменённая хэш-функция (Расчёт хэша)
var calculateHash = (nonce, previousHash , timestamp , data , difficulty) => {
    var text = nonce + previousHash + timestamp;
    text = text.toString() + CryptoJS.SHA1(data);
    var coded = "";
    for (var i = 0; i < text.length; i++) {
        var index = Alphabet.indexOf(text.charAt(i));
        if (index + difficulty >= Alphabet.length) {
            coded = coded + Alphabet.charAt((difficulty - (Alphabet.length - index)) % Alphabet.length);
        }
        else coded = coded + Alphabet.charAt(index + difficulty);
    }
    return coded.toString();
};

// Добавление нового блока в блокчейн
var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        // Проверка: является ли новый блок, который мы хотим добавить в наш блокчейн, действительным
        blockchain.push(newBlock);
    }
};

// Проверка, является ли новый блок действительным
var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } 
    else if (previousBlock.hash!== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    } 
    else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof(newBlock.hash) + ' '+ typeofcalculateHashForBlock(newBlock));
        console.log('invalid hash: '+ calculateHashForBlock(newBlock) + ' '+ newBlock.hash);
        return false;
    }
    return true;
};

// Замена цепочки блоков
// Если узел получает цепочку блоков от другого узла, и эта цепочка длиннее и действительна, то узел заменяет свою текущую цепочку на новую
var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length> blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain= newBlocks;
        broadcast(responseLatestMsg()); // Отправляем всем узлам сообщение о том, что у нас появился новая цепочка блоков
    } 
    else {
        console.log('Received blockchain invalid');
    }
};

// Проверка, является ли цепочка блоков действительной
var isValidChain = (blockchainToValidate) => {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) { // Проверяем, совпадают ли генезис-блоки
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]]; // Создаем временный массив блоков и добавляем в него генезисный блок
    for (var i = 1; i < blockchainToValidate.length; i++) { // Цикл будет пройден по каждому блоку в проверяемой цепочке, начиная со второго блока
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i-1])) { // Проверка: является ли текущий блок действительным
            tempBlocks.push(blockchainToValidate[i]); // Если да, добавляем его в массив
        } 
        else {
            return false;
        }
    }
    return true;
};

// Получение последнего блока
var getLatestBlock = () => blockchain[blockchain.length-1];
// Создание сообщения с запросом на последний блок
var queryChainLengthMsg = () => ({
    'type':MessageType.QUERY_LATEST
});
// Создание сообщения с запросом на весь блокчейн
var queryAllMsg = () => ({'type':MessageType.QUERY_ALL});
// Отправка ответа на запрос всего блокчейна
var responseChainMsg = () => ({'type':MessageType.RESPONSE_BLOCKCHAIN, 'data':JSON.stringify(blockchain)});
// Отправка ответа на запрос последнего блока
var responseLatestMsg = () => ({'type':MessageType.RESPONSE_BLOCKCHAIN,'data':JSON.stringify([getLatestBlock()])});
// Функция для записи сообщений (веб-сокет + сообщение)
var write = (ws, message) => ws.send(JSON.stringify(message));
// Функция для рассылки сообщений всем пирам
var broadcast = (message) => sockets.forEach(socket=>write(socket, message));

// Инициализация серверов
connectToPeers(initialPeers); // Подключение к другим узлам в сети
initHttpServer(); // Для общения пользователя с блокчейном
initP2PServer(); // Для общения между узлами в блокчейн-сети