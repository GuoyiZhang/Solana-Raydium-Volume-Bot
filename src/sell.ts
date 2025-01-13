import {Connection, Keypair, LAMPORTS_PER_SOL, PublicKey} from '@solana/web3.js';
// 从 Solana 的 web3.js 库导入创建密钥对、连接、公共密钥和 LAMPORTS 转换工具。
import {
    ADDITIONAL_FEE,
    BUY_AMOUNT,
    BUY_INTERVAL_MAX,
    BUY_INTERVAL_MIN,
    BUY_LOWER_AMOUNT,
    BUY_UPPER_AMOUNT,
    DISTRIBUTE_WALLET_NUM,
    IS_RANDOM,
    PRIVATE_KEY,
    RPC_ENDPOINT,
    RPC_WEBSOCKET_ENDPOINT,
    TOKEN_MINT,
} from './constants';
// 从 constants 文件中导入一些配置常量。
import {sleep} from './utils';
// 从 utils 文件中导入 sleep 函数，用于延迟操作。
import base58 from 'bs58';
// 导入 Base58 编解码工具，用于处理 Solana 的密钥。
import {ApiPoolInfoV4} from '@raydium-io/raydium-sdk';
// 导入 Raydium SDK，用于处理流动性池操作。

// 初始化 Solana 链的连接
export const solanaConnection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

// 创建主密钥对
export const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY));
// 目标代币的 Mint 地址
const baseMint = new PublicKey(TOKEN_MINT);
// 限制分发钱包数量，最多为 10
const distritbutionNum = DISTRIBUTE_WALLET_NUM > 10 ? 10 : DISTRIBUTE_WALLET_NUM;

// 声明流动性池的变量
let quoteVault: PublicKey | null = null;
let poolId: PublicKey;
let poolKeys: null | ApiPoolInfoV4 = null;

// 一些全局的操作参数
const MAX_RETRIES = 10;          // 最大重试次数
const RETRY_DELAY = 2000;        // 重试间隔（毫秒）
const POST_BUY_DELAY = 1000;     // 买入后延迟时间（毫秒）
const POST_SELL_DELAY = 5000;    // 卖出后延迟时间（毫秒）

// 自定义错误类，用于余额不足的情况
class InsufficientBalanceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InsufficientBalanceError';
    }
}

// 交易循环函数
async function executeTradeLoop(kp: Keypair, initBalance: number, poolId: PublicKey) {
    let soldIndex = 1; // 记录卖出的索引

    while (true) {
        try {
            // 计算买入金额
            const buyAmount = calculateBuyAmount();
            // 验证钱包余额是否足够
            await validateBalance(kp, buyAmount);

            // 重试买入操作
            await retryOperation(() => buy(kp, baseMint, buyAmount, poolId));
            await sleep(POST_BUY_DELAY); // 买入后延迟

            // 重试卖出操作
            await retryOperation(() => sell(poolId, baseMint, kp, soldIndex, initBalance));
            soldIndex++;

            // 计算下一次买入间隔时间
            const interval = calculateInterval(distritbutionNum);
            await sleep(POST_SELL_DELAY + interval); // 卖出后延迟
        } catch (error) {
            if (error instanceof InsufficientBalanceError) {
                console.log(error.message); // 如果余额不足，退出循环
                return;
            }
            console.error('Trade loop error:', error); // 打印其他错误
            await sleep(RETRY_DELAY); // 等待后重试
        }
    }
}

// 计算买入金额
function calculateBuyAmount(): number {
    if (!IS_RANDOM) return BUY_AMOUNT; // 如果不启用随机金额，返回固定金额
    return Number((Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT).toFixed(6));
}

// 验证钱包余额是否足够
async function validateBalance(wallet: Keypair, requiredAmount: number) {
    const solBalance = (await solanaConnection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
    if (solBalance < ADDITIONAL_FEE) {
        throw new InsufficientBalanceError(`Balance is not enough: ${solBalance} SOL`); // 抛出余额不足错误
    }
}

// 重试操作的通用函数
async function retryOperation<T>(operation: () => Promise<T>, maxRetries = MAX_RETRIES): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const result = await operation();
            if (result) return result; // 如果操作成功，返回结果
        } catch (error) {
            console.log(`Attempt ${i + 1} failed, retrying...`); // 打印失败信息
        }
        await sleep(RETRY_DELAY); // 等待重试
    }
    throw new Error(`Operation failed after ${maxRetries} attempts`); // 超过重试次数后抛出错误
}

// 主函数
const main = async () => {
    // 分发 SOL 和代币
    const data = await distributeSolAndToken(mainKp, distritbutionNum, baseMint);
    if (!data) {
        console.log('Distribution failed'); // 如果分发失败，直接退出
        return;
    }

    // 并行处理钱包，带有速率限制
    await Promise.all(
        data.map(async ({kp}, i) => {
            await sleep(((BUY_INTERVAL_MAX + BUY_INTERVAL_MIN) * i) / 2); // 每个钱包的间隔时间

            const initBalance = await validateInitialBalance(kp); // 验证初始余额
            if (!initBalance) return; // 如果余额不足，跳过该钱包

            await executeTradeLoop(kp, initBalance, poolId); // 开始交易循环
        }),
    );
};