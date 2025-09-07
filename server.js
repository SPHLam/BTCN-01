// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const secp256k1 = require('secp256k1');
const { randomBytes } = require('crypto');
const createHash = require('create-hash');
const bs58check = require('bs58check');
const bodyParser = require('body-parser');

class UnspentTxOut {
  constructor(txOutId, txOutIndex, address, amount) {
    this.txOutId = txOutId;
    this.txOutIndex = txOutIndex;
    this.address = address;
    this.amount = amount;
  }
}

class Block {
  constructor(index, previousHash, timestamp, transactions, nonce, hash) {
    this.index = index;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.nonce = nonce;
    this.hash = hash;
  }
}

let mockUTXOs = [];
let blockchain = [];

// Add this near the top of server.js, after the imports and class definitions
function createWallet() {
  let privateKey;
  do {
    privateKey = randomBytes(32);
  } while (!secp256k1.privateKeyVerify(privateKey));

  const publicKey = secp256k1.publicKeyCreate(privateKey);
  const publicKeyHash = createHash('sha256').update(publicKey).digest();
  const ripemd160Hash = createHash('ripemd160').update(publicKeyHash).digest();
  const versionPrefix = Buffer.from([0x00]);
  const payload = Buffer.concat([versionPrefix, ripemd160Hash]);
  const checksum = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().slice(0, 4);
  const address = bs58check.default.encode(Buffer.concat([payload, checksum]));

  // Assign initial balance by creating UTXOs
  const initialBalance = 10; // e.g., 10 BTC for testing
  const txId = 'genesis_' + Date.now(); // Unique transaction ID for the initial UTXO
  const initialUtxo = new UnspentTxOut(txId, 0, address, initialBalance);
  mockUTXOs.push(initialUtxo); // Add to global UTXO pool

  // Broadcast new wallet creation with initial balance
  io.emit('new-wallet', { address, initialBalance });

  return {
    privateKey: privateKey.toString('hex'),
    publicKey: publicKey.toString('hex'),
    address: address,
    initialBalance: initialBalance
  };
}

function proofOfWork(blockData, difficulty = 4) {
  let nonce = 0;
  const target = '0'.repeat(difficulty);
  const data = JSON.stringify(blockData);

  while (true) {
    const hash = createHash('sha256').update(data + nonce).digest('hex');
    if (hash.startsWith(target)) {
      return { nonce, hash };
    }
    nonce++;
  }
}

function createBlock(transactions, previousHash) {
  const index = blockchain.length;
  const timestamp = Date.now();
  const blockData = { index, previousHash, timestamp, transactions };
  const { nonce, hash } = proofOfWork(blockData);

  return new Block(index, previousHash, timestamp, transactions, nonce, hash);
}

function getAccountStats(address) {
  const utxos = mockUTXOs.filter(utxo => utxo.address === address);
  const balance = utxos.reduce((sum, utxo) => sum + utxo.amount, 0);

  return {
    address: address,
    balance: balance,
    utxoCount: utxos.length - 1,
    utxos: utxos
  };
}

function getTransactionHistory(address) {
  const transactions = [];

  blockchain.forEach(block => {
    block.transactions.forEach(tx => {
      const isSender = tx.outputs[1].address == address;
      const isReceiver = tx.outputs[0].address == address;

      if (isSender || isReceiver) {
        let fromAddress = tx.outputs[1].address;
        let toAddress = tx.outputs[0].address;
        transactions.push({
          txId: tx.txId,
          timestamp: new Date(block.timestamp).toLocaleString(),
          blockIndex: block.index,
          blockHash: block.hash,
          from: fromAddress,
          to: toAddress,
          totalAmount: isReceiver ? tx.outputs[0].amount : tx.outputs[1].amount,
          type: isReceiver ? 'Received' : 'Sent'
        });
      }
    });
  });

  return {
    address,
    transactionCount: transactions.length,
    transactions
  };
}

function sendCoin(fromAddress, privateKey, toAddress, amountToSend) {
  const { utxos, balance } = getAccountStats(fromAddress);

  if (balance < amountToSend) {
    throw new Error('Insufficient balance to send ' + amountToSend + ' BTC');
  }

  let inputAmount = 0;
  const selectedUtxos = [];
  for (const utxo of utxos) {
    selectedUtxos.push(utxo);
    inputAmount += utxo.amount;
    if (inputAmount >= amountToSend) break;
  }

  if (inputAmount < amountToSend) {
    throw new Error('Not enough UTXO to cover the amount');
  }

  const fee = 0.01;
  const change = inputAmount - amountToSend - fee;

  const txId = 'tx' + Date.now();
  const transaction = {
    txId: txId,
    timestamp: Date.now(),
    inputs: selectedUtxos.map(utxo => ({
      txId: utxo.txOutId,
      vout: utxo.txOutIndex
    })),
    outputs: [
      { address: toAddress, amount: amountToSend },
      ...(change > 0 ? [{ address: fromAddress, amount: change }] : [])
    ]
  };

  const txData = JSON.stringify(transaction);
  const txHash = createHash('sha256').update(txData).digest();
  const privateKeyBuffer = Buffer.from(privateKey, 'hex');
  const { signature } = secp256k1.ecdsaSign(txHash, privateKeyBuffer);

  const publicKey = secp256k1.publicKeyCreate(privateKeyBuffer);
  const isValid = secp256k1.ecdsaVerify(signature, txHash, publicKey);

  // Update UTXOs atomically
  mockUTXOs = mockUTXOs.filter(utxo => !selectedUtxos.includes(utxo));
  transaction.outputs.forEach((output, index) => {
    mockUTXOs.push(new UnspentTxOut(txId, index, output.address, output.amount));
  });

  const previousHash = blockchain.length > 0 ? blockchain[blockchain.length - 1].hash : '0'.repeat(64);
  const block = createBlock([transaction], previousHash);
  blockchain.push(block);

  // Emit new-transaction event only once
  //io.emit('new-transaction', { from: fromAddress, to: toAddress });

  return {
    transaction: transaction,
    signature: signature.toString('hex'),
    isValid: isValid,
    block: block
  };
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(bodyParser.json());

// API to get account stats
app.get('/account-stats/:address', (req, res) => {
  try {
    const stats = getAccountStats(req.params.address);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to get transaction history
app.get('/transaction-history/:address', (req, res) => {
  try {
    const history = getTransactionHistory(req.params.address);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to send coin (for simplicity, accepting privateKey; in real-world, client should sign and send signed tx)
app.post('/send-coin', (req, res) => {
  try {
    const { fromAddress, privateKey, toAddress, amount } = req.body;
    const result = sendCoin(fromAddress, privateKey, toAddress, amount);
    // Broadcast update to all connected clients
    io.emit('new-transaction', { from: fromAddress, to: toAddress });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add new API endpoint for wallet creation
app.post('/create-wallet', (req, res) => {
  try {
    const wallet = createWallet();
    res.json(wallet);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.io for real-time updates
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Clients can request initial data or subscribe, but for simplicity, we broadcast on events

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start server
const PORT = 3000;
app.use(express.static('public'));
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// For testing, add initial UTXOs if needed (can be done via clients)

