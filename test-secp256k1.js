const secp256k1 = require('secp256k1');
const { randomBytes } = require('crypto');
const createHash = require('create-hash');
const bs58check = require('bs58check');

// Lớp UnspentTxOut
class UnspentTxOut {
  constructor(txOutId, txOutIndex, address, amount) {
    this.txOutId = txOutId;
    this.txOutIndex = txOutIndex;
    this.address = address;
    this.amount = amount;
  }
}

// Lớp Block
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

// Hàm tạo ví Bitcoin (yêu cầu #1)
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

  return {
    privateKey: privateKey.toString('hex'),
    publicKey: publicKey.toString('hex'),
    address: address
  };
}

// Danh sách UTXO và blockchain
let mockUTXOs = [];
let blockchain = [];

// Hàm lấy thống kê tài khoản (yêu cầu #2)
function getAccountStats(address) {
  try {
    const utxos = mockUTXOs.filter(utxo => utxo.address === address);
    const balance = utxos.reduce((sum, utxo) => sum + utxo.amount, 0);

    return {
      address: address,
      balance: balance,
      utxoCount: utxos.length,
      utxos: utxos
    };
  } catch (error) {
    console.error('Error fetching account stats:', error.message);
    throw error;
  }
}

// Hàm Proof of Work (yêu cầu #3)
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

// Hàm tạo khối mới (yêu cầu #3)
function createBlock(transactions, previousHash) {
  const index = blockchain.length;
  const timestamp = Date.now();
  const blockData = { index, previousHash, timestamp, transactions };
  const { nonce, hash } = proofOfWork(blockData);

  return new Block(index, previousHash, timestamp, transactions, nonce, hash);
}

// Hàm gửi coin đến địa chỉ khác (yêu cầu #3)
function sendCoin(fromAddress, privateKey, toAddress, amountToSend) {
  try {
    // Lấy UTXO của địa chỉ gửi
    const { utxos, balance } = getAccountStats(fromAddress);

    // Kiểm tra số dư
    if (balance < amountToSend) {
      throw new Error('Insufficient balance to send ' + amountToSend + ' BTC');
    }

    // Chọn UTXO để sử dụng
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

    // Tính phí giao dịch (giả lập: 0.01 BTC)
    const fee = 0.01;
    const change = inputAmount - amountToSend - fee;

    // Tạo giao dịch
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

    // Ký giao dịch
    const txData = JSON.stringify(transaction);
    const txHash = createHash('sha256').update(txData).digest();
    const privateKeyBuffer = Buffer.from(privateKey, 'hex');
    const { signature } = secp256k1.ecdsaSign(txHash, privateKeyBuffer);

    // Xác minh chữ ký
    const publicKey = secp256k1.publicKeyCreate(privateKeyBuffer);
    const isValid = secp256k1.ecdsaVerify(signature, txHash, publicKey);

    // Cập nhật UTXO
    mockUTXOs = mockUTXOs.filter(utxo => !selectedUtxos.includes(utxo));
    transaction.outputs.forEach((output, index) => {
      mockUTXOs.push(new UnspentTxOut(txId, index, output.address, output.amount));
    });

    // Tạo khối mới với giao dịch
    const previousHash = blockchain.length > 0 ? blockchain[blockchain.length - 1].hash : '0'.repeat(64);
    const block = createBlock([transaction], previousHash);
    blockchain.push(block);

    return {
      transaction: transaction,
      signature: signature.toString('hex'),
      isValid: isValid,
      block: block
    };
  } catch (error) {
    console.error('Error creating transaction:', error.message);
    throw error;
  }
}

// Hàm xem lịch sử giao dịch (yêu cầu #4)
function getTransactionHistory(address) {
  const transactions = [];

  blockchain.forEach(block => {
    block.transactions.forEach(tx => {
      // Xác định có phải người gửi không
      const isSender = tx.inputs.some(input => {
        let sourceOutput = mockUTXOs.find(u => u.txOutId === input.txId && u.txOutIndex === input.vout);
        if (!sourceOutput) {
          blockchain.forEach(b => {
            b.transactions.forEach(t => {
              if (t.txId === input.txId) {
                sourceOutput = t.outputs[input.vout];
              }
            });
          });
        }
        return sourceOutput && sourceOutput.address === address;
      });

      // Xác định có phải người nhận không
      const isReceiver = tx.outputs.some(output => output.address === address);

      if (isSender || isReceiver) {
        // Lấy fromAddress từ input đầu tiên
        let fromAddress = 'Unknown';
        if (tx.inputs.length > 0) {
          let sourceOutput = mockUTXOs.find(u => u.txOutId === tx.inputs[0].txId && u.txOutIndex === tx.inputs[0].vout);
          if (!sourceOutput) {
            blockchain.forEach(b => {
              b.transactions.forEach(t => {
                if (t.txId === tx.inputs[0].txId) {
                  sourceOutput = t.outputs[tx.inputs[0].vout];
                }
              });
            });
          }
          if (sourceOutput) fromAddress = sourceOutput.address;
        }

        transactions.push({
          txId: tx.txId,
          timestamp: new Date(block.timestamp).toLocaleString(),
          blockIndex: block.index,
          blockHash: block.hash,
          from: fromAddress,
          to: tx.outputs.map(o => ({ address: o.address, amount: o.amount })),
          totalAmount: tx.outputs.reduce((sum, o) => sum + o.amount, 0),
          type: isSender ? 'Sent' : 'Received'
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

// Thực thi và in kết quả
function main() {
  try {
    // Tạo ví mới
    const wallet = createWallet();
    console.log('Wallet Created:');
    console.log('Private Key:', wallet.privateKey);
    console.log('Public Key:', wallet.publicKey);
    console.log('Address:', wallet.address);

    // Thêm UTXO giả lập cho ví mới
    mockUTXOs = [
      new UnspentTxOut('tx1', 0, wallet.address, 0.5),
      new UnspentTxOut('tx2', 1, wallet.address, 1.2),
      new UnspentTxOut('tx3', 0, '1DifferentAddress', 0.8)
    ];

    // Lấy thống kê tài khoản trước giao dịch
    const statsBefore = getAccountStats(wallet.address);
    console.log('\nAccount Statistics (Before Transactions):');
    console.log('Address:', statsBefore.address);
    console.log('Balance (BTC):', statsBefore.balance);
    console.log('Number of UTXOs:', statsBefore.utxoCount);
    console.log('UTXOs:');
    statsBefore.utxos.forEach(utxo => {
      console.log(`  - TxID: ${utxo.txOutId}, Output Index: ${utxo.txOutIndex}, Amount: ${utxo.amount} BTC`);
    });

    // Gửi coin (giao dịch 1)
    const recipientAddress1 = '1RecipientAddr1234567890abcdef';
    const amountToSend1 = 0.7;
    const tx1 = sendCoin(wallet.address, wallet.privateKey, recipientAddress1, amountToSend1);

    console.log('\nTransaction 1 Created:');
    console.log('Transaction:', JSON.stringify(tx1.transaction, null, 2));
    console.log('Signature:', tx1.signature);
    console.log('Signature Valid:', tx1.isValid);
    console.log('Block Index:', tx1.block.index);
    console.log('Block Hash:', tx1.block.hash);

    // Gửi coin (giao dịch 2)
    const recipientAddress2 = '1AnotherAddr9876543210fedcba';
    const amountToSend2 = 0.3;
    const tx2 = sendCoin(wallet.address, wallet.privateKey, recipientAddress2, amountToSend2);

    console.log('\nTransaction 2 Created:');
    console.log('Transaction:', JSON.stringify(tx2.transaction, null, 2));
    console.log('Signature:', tx2.signature);
    console.log('Signature Valid:', tx2.isValid);
    console.log('Block Index:', tx2.block.index);
    console.log('Block Hash:', tx2.block.hash);

    // Lấy thống kê tài khoản sau giao dịch
    const statsAfter = getAccountStats(wallet.address);
    console.log('\nAccount Statistics (After Transactions):');
    console.log('Address:', statsAfter.address);
    console.log('Balance (BTC):', statsAfter.balance);
    console.log('Number of UTXOs:', statsAfter.utxoCount);
    console.log('UTXOs:');
    statsAfter.utxos.forEach(utxo => {
      console.log(`  - TxID: ${utxo.txOutId}, Output Index: ${utxo.txOutIndex}, Amount: ${utxo.amount} BTC`);
    });

    // Xem lịch sử giao dịch (yêu cầu #4)
    const history = getTransactionHistory(wallet.address);
    console.log('\nTransaction History:');
    console.log('Address:', history.address);
    console.log('Transaction Count:', history.transactionCount);
    console.log('Transactions:');
    history.transactions.forEach(tx => {
      console.log(`  - TxID: ${tx.txId}`);
      console.log(`    Timestamp: ${tx.timestamp}`);
      console.log(`    Block Index: ${tx.blockIndex}`);
      console.log(`    Block Hash: ${tx.blockHash}`);
      console.log(`    From: ${tx.from}`);
      console.log(`    To: ${JSON.stringify(tx.to, null, 2)}`);
      console.log(`    Total Amount: ${tx.totalAmount} BTC`);
      console.log(`    Type: ${tx.type}`);
    });
  } catch (error) {
    console.error('Failed to process:', error.message);
  }
}

main();