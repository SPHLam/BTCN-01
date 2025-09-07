// client.js
const io = require('socket.io-client');
const axios = require('axios');
const readline = require('readline');

let wallet = null;

// Connect to server
const socket = io('http://localhost:3000');

socket.on('connect', async () => {
  console.log('Connected to server');
  // Create wallet by calling server
  try {
    const response = await axios.post('http://localhost:3000/create-wallet');
    wallet = response.data;
    console.log('Your Wallet:');
    console.log('Address:', wallet.address);
    console.log('Private Key:', wallet.privateKey);
    console.log('Initial Balance:', wallet.initialBalance);
    // Fetch initial stats after wallet creation
    await getStats();
  } catch (error) {
    console.error('Error creating wallet:', error.message);
  }
});

socket.on('new-wallet', (data) => {
  // Add null check for wallet
  if (wallet && data.address === wallet.address) {
    console.log(`Wallet ${data.address} created with initial balance: ${data.initialBalance} BTC`);
    getStats();
  }
});

socket.on('new-transaction', (data) => {
  if (wallet && (data.from === wallet.address || data.to === wallet.address)) {
    console.log('New transaction detected! Refreshing stats and history...');
    getStats();
    getHistory();
  }
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
});

async function getStats() {
  if (!wallet) {
    console.log('Wallet not initialized yet.');
    return;
  }
  try {
    const response = await axios.get(`http://localhost:3000/account-stats/${wallet.address}`);
    console.log('Account Stats:');
    console.log('Balance:', response.data.balance);
    console.log('UTXO Count:', response.data.utxoCount);
  } catch (error) {
    console.error('Error getting stats:', error.message);
  }
}

async function getHistory() {
  if (!wallet) {
    console.log('Wallet not initialized yet.');
    return;
  }
  try {
    const response = await axios.get(`http://localhost:3000/transaction-history/${wallet.address}`);
    console.log('Transaction History:');
    response.data.transactions.forEach(tx => {
      console.log(`- TxID: ${tx.txId}, Type: ${tx.type}, Amount: ${tx.totalAmount}`);
    });
  } catch (error) {
    console.error('Error getting history:', error.message);
  }
}

async function sendCoin(toAddress, amount) {
  if (!wallet) {
    console.log('Wallet not initialized yet.');
    return;
  }
  try {
    const response = await axios.post('http://localhost:3000/send-coin', {
      fromAddress: wallet.address,
      privateKey: wallet.privateKey,
      toAddress,
      amount
    });
    console.log('Transaction sent:', response.data.transaction.txId);
  } catch (error) {
    console.error('Error sending coin:', error.message);
  }
}

rl.prompt();

rl.on('line', async (line) => {
  const [command, ...args] = line.trim().split(' ');
  switch (command) {
    case 'stats':
      await getStats();
      break;
    case 'history':
      await getHistory();
      break;
    case 'send':
      if (args.length === 2) {
        const toAddress = args[0];
        const amount = parseFloat(args[1]);
        await sendCoin(toAddress, amount);
      } else {
        console.log('Usage: send <toAddress> <amount>');
      }
      break;
    case 'exit':
      rl.close();
      break;
    default:
      console.log('Commands: stats, history, send <to> <amount>, exit');
  }
  rl.prompt();
}).on('close', () => {
  socket.disconnect();
  process.exit(0);
});