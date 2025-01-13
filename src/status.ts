import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  CHECK_BAL_INTERVAL,
  DISTRIBUTE_WALLET_NUM,
  LOG_LEVEL,
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  TOKEN_MINT,
} from './constants';
import { deleteConsoleLines, logger, PoolKeys, readJson, sleep } from './utils';
import base58 from 'bs58';
import { PoolState } from './types';

// 初始化 Solana 链连接
export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

// 从私钥中创建密钥对（主钱包）
export const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY));

// 目标代币的 Mint 地址
const baseMint = new PublicKey(TOKEN_MINT);
// 限制分发数量最大 20 个钱包
const distritbutionNum = DISTRIBUTE_WALLET_NUM > 20 ? 20 : DISTRIBUTE_WALLET_NUM;

// 声明一些全局变量，用于后续统计
let quoteVault: PublicKey | null = null;
let poolKeys: LiquidityPoolKeysV4;
let sold: number = 0;
let bought: number = 0;
let totalSolPut: number = 0;
let changeAmount = 0;
let buyNum = 0;
let sellNum = 0;

// 设置日志级别
logger.level = LOG_LEVEL;

// 定义程序状态接口
interface Data {
  privateKey: string;
  pubkey: string;
  solBalance: number | null;
  tokenBuyTx: string | null;
  tokenSellTx: string | null;
}

// 从 data.json 读取钱包信息
const data: Data[] = readJson();
// 提取出所有钱包的公钥
const walletPks = data.map((data) => data.pubkey);
console.log('🚀 ~ walletPks:', walletPks);

// 定义池子整体状态
const state: PoolState = {
  quoteVault: null,
  poolKeys: null,
  stats: {
    sold: 0,
    bought: 0,
    totalSolPut: 0,
    changeAmount: 0,
    buyNum: 0,
    sellNum: 0,
  },
};

/**
 * 初始化连接：检查主钱包余额、获取 Raydium 池子信息等
 * @returns 返回池子的 ID
 */
const initializeConnection = async () => {
  try {
    // 获取主钱包 SOL 余额
    const solBalance = await solanaConnection.getBalance(mainKp.publicKey);
    console.log({
      walletAddress: mainKp.publicKey.toBase58(),
      poolTokenMint: baseMint.toBase58(),
      solBalance: (solBalance / LAMPORTS_PER_SOL).toFixed(3),
      checkInterval: CHECK_BAL_INTERVAL,
    });

    // 获取目标池子的关键信息（BaseMint 对 NATIVE_MINT）
    state.poolKeys = await PoolKeys.fetchPoolKeyInfo(solanaConnection, baseMint, NATIVE_MINT);
    // 引用池子的 quoteVault 地址，用于后续观察
    state.quoteVault = state.poolKeys.quoteVault;

    // 返回池子的 ID
    return state.poolKeys.id;
  } catch (error) {
    logger.error('Failed to initialize connection:', error);
    throw error;
  }
};

/**
 * 跟踪 quoteVault 的交易和余额变动
 * @param connection Solana Connection
 * @param quoteVault 代币账户地址（此处为池子的 quoteVault）
 */
async function trackWalletOnLog(connection: Connection, quoteVault: PublicKey): Promise<void> {
  // 获取初始 wSOL 余额
  const initialWsolBal = await getTokenBalance(connection, quoteVault);
  if (!initialWsolBal) return;

  // 设置定时器，定期检查余额变动
  setupBalanceChecking(connection, quoteVault, initialWsolBal);

  // 监听该账户相关的交易日志
  setupTransactionMonitoring(connection, quoteVault);
}

/**
 * 获取指定账户的代币余额
 * @param connection Solana Connection
 * @param vault 代币账户地址
 * @returns uiAmount 或 null
 */
async function getTokenBalance(connection: Connection, vault: PublicKey): Promise<number | null> {
  try {
    const balance = (await connection.getTokenAccountBalance(vault)).value.uiAmount;
    if (!balance) {
      logger.error('Quote vault mismatch');
      return null;
    }
    return balance;
  } catch (error) {
    logger.error('Failed to get token balance:', error);
    return null;
  }
}

/**
 * 设置定时任务，周期性检查 quoteVault 的余额，并计算变化值
 * @param connection Solana Connection
 * @param quoteVault 池子的 quoteVault
 * @param initialBalance 初始余额
 */
function setupBalanceChecking(connection: Connection, quoteVault: PublicKey, initialBalance: number) {
  setInterval(async () => {
    const currentBalance = await getTokenBalance(connection, quoteVault);
    if (!currentBalance) return;

    // 记录当前余额变化情况
    state.stats.changeAmount = currentBalance - initialBalance;
    // 删除终端上一行内容，更新显示
    deleteConsoleLines(1);
    console.log(
        `Other users bought ${state.stats.buyNum - state.stats.bought} times and ` +
        `sold ${state.stats.sellNum - state.stats.sold} times, ` +
        `total SOL change is ${state.stats.changeAmount - state.stats.totalSolPut}SOL`,
    );
  }, CHECK_BAL_INTERVAL);
}

/**
 * 监听 quoteVault 相关的所有交易日志，解析交易来区分是买入还是卖出
 * @param connection Solana Connection
 * @param quoteVault 池子的 quoteVault
 */
function setupTransactionMonitoring(connection: Connection, quoteVault: PublicKey) {
  connection.onLogs(
      quoteVault,
      async ({ err, signature }) => {
        if (err) return; // 如果日志里有错误信息，直接跳过

        try {
          // 获取解析后的交易详情
          const parsedData = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });

          // 找到执行交易的 signer
          const signer = parsedData?.transaction.message.accountKeys.find((elem: any) => elem.signer)?.pubkey.toBase58();

          // 如果 signer 不在我们记录的钱包列表里，说明是“其他用户”在进行交易
          if (signer && !walletPks.includes(signer)) {
            // 判断 preBalance 是否大于 postBalance 来推断是买入还是卖出
            const isUserBuying = Number(parsedData?.meta?.preBalances[0]) > Number(parsedData?.meta?.postBalances[0]);
            isUserBuying ? state.stats.buyNum++ : state.stats.sellNum++;
          }
        } catch (error) {
          logger.error('Error processing transaction:', error);
        }
      },
      'confirmed',
  );
}

/**
 * 主函数
 * 1. 初始化连接并获取池子 ID
 * 2. 对 quoteVault 进行交易和余额跟踪
 */
const main = async () => {
  try {
    const poolId = await initializeConnection();
    // 对池子的 quoteVault 进行日志和余额跟踪
    await trackWalletOnLog(solanaConnection, state.quoteVault!);
  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
};

// 启动主函数
main();