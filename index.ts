import { NATIVE_MINT, getAssociatedTokenAddress } from '@solana/spl-token';
// 引入 SPL Token 工具，用于获取关联账户地址等操作

import {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  ComputeBudgetProgram,
  Transaction,
} from '@solana/web3.js';
// Solana Web3.js 库，用于管理密钥对、连接节点、构建交易等

import base58 from 'bs58';
// Base58 编解码库，用于处理密钥和公钥字符串

import {
  ADDITIONAL_FEE,        // 额外费用
  BUY_AMOUNT,            // 固定买入金额
  BUY_INTERVAL_MAX,      // 最大买入间隔
  BUY_INTERVAL_MIN,      // 最小买入间隔
  BUY_LOWER_AMOUNT,      // 随机买入的下限
  BUY_UPPER_AMOUNT,      // 随机买入的上限
  DISTRIBUTE_WALLET_NUM, // 分发目标钱包数量
  DISTRIBUTION_AMOUNT,   // 单个钱包分发的 SOL 数量
  IS_RANDOM,             // 是否随机买入
  PRIVATE_KEY,           // 主钱包私钥
  RPC_ENDPOINT,          // Solana RPC 端点
  RPC_WEBSOCKET_ENDPOINT,// Solana WebSocket 端点
  TOKEN_MINT,            // 目标代币的 mint
} from './src/constants';
// 从项目的常量文件中读取各种配置参数

import { Data, editJson, readJson, saveDataToFile, sleep } from './src/utils';
// 项目中的工具函数和类型，包括读写 JSON、延迟、编辑 JSON 文件等

import { getBuyTx, getBuyTxWithJupiter, getSellTx, getSellTxWithJupiter } from './src/utils/swapOnlyAmm';
// 从 swapOnlyAmm 文件中引入买卖交易生成函数

import { execute } from './src/executor/legacy';
// execute 函数，用于发送并确认交易

import { getPoolKeys } from './src/utils/getPoolInfo';
// 获取 Raydium 池子信息的工具函数

import { SWAP_ROUTING } from './src/constants';
// 是否启用 Jupiter Swap 路由

// 建立与 Solana 的连接
export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

// 主钱包密钥对，使用 Base58 解码私钥并生成 Keypair
export const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY));

// 目标代币的 mint 地址
const baseMint = new PublicKey(TOKEN_MINT);

// 限制分发钱包数量，最多分发给 10 个钱包
const distritbutionNum = DISTRIBUTE_WALLET_NUM > 10 ? 10 : DISTRIBUTE_WALLET_NUM;

// 这里定义一些全局变量
let poolId: PublicKey;
let poolKeys = null;

/**
 * main 函数入口
 * 1. 打印一些基础信息
 * 2. 获取或生成 Raydium 池子信息（如果不走 Jupiter 路由）
 * 3. 检查主钱包是否有足够的 SOL 进行分发
 * 4. 分发 SOL 给指定数量的钱包
 * 5. 为每个分发到的钱包执行持续的买卖循环
 */
const main = async () => {
  // 读取主钱包的 SOL 余额
  const solBalance = (await solanaConnection.getBalance(mainKp.publicKey)) / LAMPORTS_PER_SOL;

  console.log(`Volume bot is running`);
  console.log(`Wallet address: ${mainKp.publicKey.toBase58()}`);
  console.log(`Pool token mint: ${baseMint.toBase58()}`);
  console.log(`Wallet SOL balance: ${solBalance.toFixed(3)}SOL`);
  console.log(`Buying interval max: ${BUY_INTERVAL_MAX}ms`);
  console.log(`Buying interval min: ${BUY_INTERVAL_MIN}ms`);
  console.log(`Buy upper limit amount: ${BUY_UPPER_AMOUNT}SOL`);
  console.log(`Buy lower limit amount: ${BUY_LOWER_AMOUNT}SOL`);
  console.log(`Distribute SOL to ${distritbutionNum} wallets`);

  // 判断是否使用 Jupiter Swap 路由
  if (SWAP_ROUTING) {
    console.log('Buy and sell with jupiter swap v6 routing');
  } else {
    // 如果不是走路由，则获取 Raydium 池子信息
    poolKeys = await getPoolKeys(solanaConnection, baseMint);
    if (poolKeys == null) {
      return;
    }
    // poolKeys.id 即池子的 ID
    poolId = new PublicKey(poolKeys.id);

    console.log(`Successfully fetched pool info`);
    console.log(`Pool id: ${poolId.toBase58()}`);
  }

  let data:
      | {
    kp: Keypair;   // 分发后生成的新钱包密钥对
    buyAmount: number; // 该钱包初始可买入的 SOL
  }[]
      | null = null;

  // 如果主钱包余额不足以向 distritbutionNum 个钱包分发最少买入额+附加费，则不进行分发
  if (solBalance < (BUY_LOWER_AMOUNT + ADDITIONAL_FEE) * distritbutionNum) {
    console.log('Sol balance is not enough for distribution');
  }

  // 分发 SOL
  data = await distributeSol(mainKp, distritbutionNum);
  if (data === null) {
    console.log('Distribution failed');
    return;
  }

  // 对分发后的每个钱包，在异步中执行买卖循环
  data.map(async ({ kp }, i) => {
    // 以一定间隔开始买卖循环，避免所有钱包一起提交交易
    await sleep(((BUY_INTERVAL_MAX + BUY_INTERVAL_MIN) * i) / 2);

    while (true) {
      // 1. 计算买入间隔
      const BUY_INTERVAL = Math.round(Math.random() * (BUY_INTERVAL_MAX - BUY_INTERVAL_MIN) + BUY_INTERVAL_MIN);

      // 2. 获取该钱包当前 SOL 余额
      const solBalance = (await solanaConnection.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;

      // 3. 计算买入金额（如果 IS_RANDOM 为 true，则随机，否则用 BUY_AMOUNT）
      let buyAmount: number;
      if (IS_RANDOM)
        buyAmount = Number((Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT).toFixed(6));
      else buyAmount = BUY_AMOUNT;

      // 如果余额不足以支付最低买入 + 手续费，则退出循环
      if (solBalance < ADDITIONAL_FEE) {
        console.log('Balance is not enough: ', solBalance, 'SOL');
        return;
      }

      // 4. 不断尝试买入，直到成功或尝试次数超过 10 次
      let i = 0;
      while (true) {
        if (i > 10) {
          console.log('Error in buy transaction');
          return;
        }
        const result = await buy(kp, baseMint, buyAmount, poolId);
        if (result) {
          break;
        } else {
          i++;
          console.log('Buy failed, try again');
          await sleep(2000);
        }
      }

      // 买入成功后，等待 3 秒
      await sleep(3000);

      // 5. 不断尝试卖出，直到成功或尝试次数超过 10 次
      let j = 0;
      while (true) {
        if (j > 10) {
          console.log('Error in sell transaction');
          return;
        }
        const result = await sell(poolId, baseMint, kp);
        if (result) {
          break;
        } else {
          j++;
          console.log('Sell failed, try again');
          await sleep(2000);
        }
      }

      // 6. 卖出后，等待 5 秒 + (分发数量 * 买入间隔)，模拟交易的随机性
      await sleep(5000 + distritbutionNum * BUY_INTERVAL);
    }
  });
};

/**
 * distributeSol 函数
 * 1. 生成指定数量（distritbutionNum）的新钱包
 * 2. 为每个新钱包分配指定金额（或略大于指定金额）的 SOL
 * 3. 将所有这些转账打包到一个 Transaction 中执行
 * 4. 将分发后的钱包信息保存到 data.json 中
 */
const distributeSol = async (mainKp: Keypair, distritbutionNum: number) => {
  const data: Data[] = [];
  const wallets = [];
  try {
    // 准备一个 TransactionInstruction 数组，用于后续批量转账
    const sendSolTx: TransactionInstruction[] = [];

    // 设置 ComputeBudget，增加交易可用计算单元
    sendSolTx.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 }),
    );

    // 根据数量生成钱包并添加转账指令
    for (let i = 0; i < distritbutionNum; i++) {
      let solAmount = DISTRIBUTION_AMOUNT;
      // 如果 DISTRIBUTION_AMOUNT 小于 (附加费 + 随机买入上限)，则强制提高分发额度
      if (DISTRIBUTION_AMOUNT < ADDITIONAL_FEE + BUY_UPPER_AMOUNT) solAmount = ADDITIONAL_FEE + BUY_UPPER_AMOUNT;

      // 新的 Keypair
      const wallet = Keypair.generate();
      wallets.push({ kp: wallet, buyAmount: solAmount });

      // 构造从主钱包到新钱包的转账指令
      sendSolTx.push(
          SystemProgram.transfer({
            fromPubkey: mainKp.publicKey,
            toPubkey: wallet.publicKey,
            lamports: solAmount * LAMPORTS_PER_SOL,
          }),
      );
    }

    // 将新生成的钱包信息记录到 data 数组，以便写入文件
    wallets.map((wallet) => {
      data.push({
        privateKey: base58.encode(wallet.kp.secretKey),
        pubkey: wallet.kp.publicKey.toBase58(),
        solBalance: wallet.buyAmount + ADDITIONAL_FEE,
        tokenBuyTx: null,
        tokenSellTx: null,
      });
    });

    // 尝试写入文件
    try {
      saveDataToFile(data);
    } catch (error) {
      // 文件写入失败也不影响后续逻辑
    }

    let index = 0;
    while (true) {
      try {
        if (index > 3) {
          console.log('Error in distribution');
          return null;
        }
        // 构造一个传统 Transaction，用于兼容 TransactionMessage 构建
        const siTx = new Transaction().add(...sendSolTx);
        const latestBlockhash = await solanaConnection.getLatestBlockhash();
        siTx.feePayer = mainKp.publicKey;
        siTx.recentBlockhash = latestBlockhash.blockhash;

        // 使用 VersionedTransaction 构造交易
        const messageV0 = new TransactionMessage({
          payerKey: mainKp.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: sendSolTx,
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        // 用主钱包签名
        transaction.sign([mainKp]);

        // 发送并确认交易
        const txSig = await execute(transaction, latestBlockhash);
        const tokenBuyTx = txSig ? `https://solscan.io/tx/${txSig}` : '';
        console.log('SOL distributed ', tokenBuyTx);
        break;
      } catch (error) {
        index++;
      }
    }

    console.log('Success in transferring sol');
    return wallets;
  } catch (error) {
    console.log(`Failed to transfer SOL`);
    return null;
  }
};

/**
 * buy 函数
 * 在给定钱包上执行买入操作
 * 1. 检查钱包 SOL 余额
 * 2. 根据 SWAP_ROUTING 判断使用 Jupiter Swap 还是 Raydium Swap
 * 3. 使用 execute 发送交易
 * 4. 更新 data.json 中的记录
 */
const buy = async (newWallet: Keypair, baseMint: PublicKey, buyAmount: number, poolId: PublicKey) => {
  let solBalance: number = 0;
  try {
    // 获取钱包余额
    solBalance = await solanaConnection.getBalance(newWallet.publicKey);
  } catch (error) {
    console.log('Error getting balance of wallet');
    return null;
  }
  if (solBalance == 0) {
    return null;
  }
  try {
    let tx;
    // 如果启用路由则使用 Jupiter，否则使用 Raydium
    if (SWAP_ROUTING) tx = await getBuyTxWithJupiter(newWallet, baseMint, buyAmount);
    else tx = await getBuyTx(solanaConnection, newWallet, baseMint, NATIVE_MINT, buyAmount, poolId.toBase58());

    if (tx == null) {
      console.log(`Error getting buy transaction`);
      return null;
    }
    // 执行交易
    const latestBlockhash = await solanaConnection.getLatestBlockhash();
    const txSig = await execute(tx, latestBlockhash);
    const tokenBuyTx = txSig ? `https://solscan.io/tx/${txSig}` : '';

    // 更新 data.json 中的钱包记录
    editJson({
      tokenBuyTx,
      pubkey: newWallet.publicKey.toBase58(),
      solBalance: solBalance / 10 ** 9 - buyAmount,
    });
    return tokenBuyTx;
  } catch (error) {
    return null;
  }
};

/**
 * sell 函数
 * 在给定钱包上执行卖出操作
 * 1. 获取钱包中该代币的账户余额
 * 2. 判断使用 Jupiter 还是 Raydium
 * 3. 发送交易并更新 data.json 中的记录
 */
const sell = async (poolId: PublicKey, baseMint: PublicKey, wallet: Keypair) => {
  try {
    const data: Data[] = readJson();
    if (data.length == 0) {
      await sleep(1000);
      return null;
    }

    // 获取该钱包的关联代币账户及其余额
    const tokenAta = await getAssociatedTokenAddress(baseMint, wallet.publicKey);
    const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta);
    if (!tokenBalInfo) {
      console.log('Balance incorrect');
      return null;
    }
    const tokenBalance = tokenBalInfo.value.amount;

    try {
      let sellTx;
      if (SWAP_ROUTING) {
        // 如果启用路由则使用 Jupiter
        sellTx = await getSellTxWithJupiter(wallet, baseMint, tokenBalance);
      } else {
        // 否则使用 Raydium
        sellTx = await getSellTx(solanaConnection, wallet, baseMint, NATIVE_MINT, tokenBalance, poolId.toBase58());
      }

      if (sellTx == null) {
        console.log(`Error getting buy transaction`);
        return null;
      }

      // 执行交易
      const latestBlockhashForSell = await solanaConnection.getLatestBlockhash();
      const txSellSig = await execute(sellTx, latestBlockhashForSell, false);
      const tokenSellTx = txSellSig ? `https://solscan.io/tx/${txSellSig}` : '';

      // 更新 data.json 中的钱包记录
      const solBalance = await solanaConnection.getBalance(wallet.publicKey);
      editJson({
        pubkey: wallet.publicKey.toBase58(),
        tokenSellTx,
        solBalance,
      });
      return tokenSellTx;
    } catch (error) {
      return null;
    }
  } catch (error) {
    return null;
  }
};

// 启动主函数
main();