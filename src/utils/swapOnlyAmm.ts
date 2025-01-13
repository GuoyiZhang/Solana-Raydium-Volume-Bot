import assert from 'assert';
// 使用 assert 库来进行断言，用于验证逻辑是否符合预期。

import {
  jsonInfo2PoolKeys,        // 将池信息的 JSON 格式转换为 Raydium 池的关键信息对象
  Liquidity,                // Raydium SDK 的流动性模块
  LiquidityPoolKeys,        // 流动性池的关键数据结构
  Percent,                  // 百分比工具，常用于滑点处理
  Token,                    // 代币类，用于表示链上的各种代币
  TokenAmount,              // 代币数量类，包含代币信息和数量
  ApiPoolInfoV4,            // 用于描述 V4 版本流动性池信息的数据结构
  LIQUIDITY_STATE_LAYOUT_V4,// Raydium V4 流动性池的账户布局
  MARKET_STATE_LAYOUT_V3,   // Raydium V3 市场账户布局
  Market,                   // Raydium 市场相关模块
  SPL_MINT_LAYOUT,          // SPL Token 的 Mint 信息布局
  SPL_ACCOUNT_LAYOUT,       // SPL Token 的账户信息布局
  TokenAccount,             // 表示 SPL Token 账户信息的类型
  TxVersion,                // 交易版本枚举，用于指定交易版本
  buildSimpleTransaction,   // 构建简单交易（VersionedTransaction）的工具
  LOOKUP_TABLE_CACHE,       // 查找表缓存，用于交易 lookup table
} from '@raydium-io/raydium-sdk';

import { PublicKey, Keypair, Connection, VersionedTransaction } from '@solana/web3.js';
// 从 Solana Web3.js 库中导入核心类和方法：公共密钥、公私钥对、连接以及版本化交易等。

import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getMint } from '@solana/spl-token';
// 从 SPL-Token 库中导入代币相关的常量和方法（获取关联账户地址、获取 Mint 信息等）。

import { TX_FEE } from '../constants';
// 自定义常量文件，包含交易手续费或其他配置。

// 类型别名：WalletTokenAccounts，用于存储钱包中的 TokenAccount 数组
type WalletTokenAccounts = Awaited<ReturnType<typeof getWalletTokenAccount>>;

// 类型声明：TestTxInputInfo，用于在 swapOnlyAmm 函数中接收的输入信息
type TestTxInputInfo = {
  outputToken: Token;               // 目标输出代币
  targetPool: string;               // 目标池子的 ID
  inputTokenAmount: TokenAmount;    // 输入代币数量
  slippage: Percent;                // 滑点
  walletTokenAccounts: WalletTokenAccounts; // 当前钱包的代币账户列表
  wallet: Keypair;                  // 当前操作的钱包密钥对
};

/**
 * 获取指定钱包的所有 Token Account 信息
 * @param connection - Solana 连接对象
 * @param wallet - 钱包地址（PublicKey）
 * @returns 返回由 TokenAccount 类型对象组成的数组
 */
async function getWalletTokenAccount(connection: Connection, wallet: PublicKey): Promise<TokenAccount[]> {
  // 调用 getTokenAccountsByOwner 获取与钱包相关的所有代币账户
  const walletTokenAccount = await connection.getTokenAccountsByOwner(wallet, {
    programId: TOKEN_PROGRAM_ID,
  });
  // 对每个账户进行解码并映射为 TokenAccount 类型
  return walletTokenAccount.value.map((i) => ({
    pubkey: i.pubkey,
    programId: i.account.owner,
    accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
  }));
}

/**
 * 基于 Raydium 池进行 AMM 交换
 * @param connection - Solana 连接对象
 * @param input - 包含 AMM 交换所需的各种信息，如输出代币、滑点、钱包等
 * @returns 返回生成的交易指令数组
 */
async function swapOnlyAmm(connection: Connection, input: TestTxInputInfo) {
  // 1. 获取池子信息
  const targetPoolInfo = await formatAmmKeysById(connection, input.targetPool);
  assert(targetPoolInfo, 'cannot find the target pool');

  // 转换成 LiquidityPoolKeys
  const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys;

  // 2. 计算兑换输出数量以及最小输出数量
  const { amountOut, minAmountOut } = Liquidity.computeAmountOut({
    poolKeys: poolKeys,
    poolInfo: await Liquidity.fetchInfo({ connection, poolKeys }),
    amountIn: input.inputTokenAmount,
    currencyOut: input.outputToken,
    slippage: input.slippage,
  });

  // 3. 生成交易指令（innerTransactions），以便后面构建交易
  const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
    connection,
    poolKeys,
    userKeys: {
      tokenAccounts: input.walletTokenAccounts,
      owner: input.wallet.publicKey,
    },
    amountIn: input.inputTokenAmount,
    amountOut: minAmountOut,
    fixedSide: 'in', // 固定输入
    makeTxVersion: TxVersion.V0,
    computeBudgetConfig: {
      microLamports: 12_000 * TX_FEE, // 动态调整费用
      units: 100_000,
    },
  });
  return innerTransactions; // 返回交易指令数组
}

/**
 * 通过池子 ID 获取池子信息并格式化为 ApiPoolInfoV4
 * @param connection - Solana 连接对象
 * @param id - 池子的公钥（string 格式）
 * @returns 返回符合 ApiPoolInfoV4 格式的对象
 */
export async function formatAmmKeysById(connection: Connection, id: string): Promise<ApiPoolInfoV4> {
  // 读取池子账户信息
  const account = await connection.getAccountInfo(new PublicKey(id));
  if (account === null) throw Error(' get id info error ');

  // 使用 V4 的流动性池布局解码账户数据
  const info = LIQUIDITY_STATE_LAYOUT_V4.decode(account.data);

  // 读取市场账户信息
  const marketId = info.marketId;
  const marketAccount = await connection.getAccountInfo(marketId);
  if (marketAccount === null) throw Error(' get market info error');
  const marketInfo = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data);

  // 读取 LP Token 的 Mint 账户信息，以获取 lpDecimals
  const lpMint = info.lpMint;
  const lpMintAccount = await connection.getAccountInfo(lpMint);
  if (lpMintAccount === null) throw Error(' get lp mint info error');
  const lpMintInfo = SPL_MINT_LAYOUT.decode(lpMintAccount.data);

  // 拼装并返回 ApiPoolInfoV4 对象
  return {
    id,
    baseMint: info.baseMint.toString(),
    quoteMint: info.quoteMint.toString(),
    lpMint: info.lpMint.toString(),
    baseDecimals: info.baseDecimal.toNumber(),
    quoteDecimals: info.quoteDecimal.toNumber(),
    lpDecimals: lpMintInfo.decimals,
    version: 4,
    programId: account.owner.toString(),
    authority: Liquidity.getAssociatedAuthority({ programId: account.owner }).publicKey.toString(),
    openOrders: info.openOrders.toString(),
    targetOrders: info.targetOrders.toString(),
    baseVault: info.baseVault.toString(),
    quoteVault: info.quoteVault.toString(),
    withdrawQueue: info.withdrawQueue.toString(),
    lpVault: info.lpVault.toString(),
    marketVersion: 3,
    marketProgramId: info.marketProgramId.toString(),
    marketId: info.marketId.toString(),
    marketAuthority: Market.getAssociatedAuthority({
      programId: info.marketProgramId,
      marketId: info.marketId,
    }).publicKey.toString(),
    marketBaseVault: marketInfo.baseVault.toString(),
    marketQuoteVault: marketInfo.quoteVault.toString(),
    marketBids: marketInfo.bids.toString(),
    marketAsks: marketInfo.asks.toString(),
    marketEventQueue: marketInfo.eventQueue.toString(),
    lookupTableAccount: PublicKey.default.toString(),
  };
}

/**
 * 基于 Raydium AMM 进行买入操作，返回已签名的交易对象
 * @param solanaConnection - Solana 连接对象
 * @param wallet - 当前操作的钱包 Keypair
 * @param baseMint - 基础代币的 Mint
 * @param quoteMint - 报价代币的 Mint
 * @param amount - 要买入的数量
 * @param targetPool - 目标池子的 ID（string 格式）
 * @returns  返回一个 VersionedTransaction，如果构造失败则返回 null
 */
export async function getBuyTx(
    solanaConnection: Connection,
    wallet: Keypair,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    amount: number,
    targetPool: string,
) {
  // 获取 baseMint 的 Mint 信息
  const baseInfo = await getMint(solanaConnection, baseMint);
  if (baseInfo == null) {
    return null;
  }
  const baseDecimal = baseInfo.decimals;

  // 构造代币对象：基础代币和报价代币
  const baseToken = new Token(TOKEN_PROGRAM_ID, baseMint, baseDecimal);
  const quoteToken = new Token(TOKEN_PROGRAM_ID, quoteMint, 9);

  // 构造输入代币数量（卖出多少 quoteToken）
  const quoteTokenAmount = new TokenAmount(quoteToken, Math.floor(amount * 10 ** 9));
  // 设置滑点
  const slippage = new Percent(100, 100);

  // 获取当前钱包的所有代币账户
  const walletTokenAccounts = await getWalletTokenAccount(solanaConnection, wallet.publicKey);

  // 生成买入指令（目标输出为 baseToken）
  const instructions = await swapOnlyAmm(solanaConnection, {
    outputToken: baseToken,
    targetPool,
    inputTokenAmount: quoteTokenAmount,
    slippage,
    walletTokenAccounts,
    wallet: wallet,
  });

  // 构建简单交易（VersionedTransaction）
  const willSendTx = (
      await buildSimpleTransaction({
        connection: solanaConnection,
        makeTxVersion: TxVersion.V0,
        payer: wallet.publicKey,
        innerTransactions: instructions,
        addLookupTableInfo: LOOKUP_TABLE_CACHE,
      })
  )[0];

  // 如果是 VersionedTransaction 类型，则用钱包签名
  if (willSendTx instanceof VersionedTransaction) {
    willSendTx.sign([wallet]);
    return willSendTx;
  }
  return null;
}

/**
 * 基于 Raydium AMM 进行卖出操作，返回已签名的交易对象
 * @param solanaConnection - Solana 连接对象
 * @param wallet - 当前操作的钱包 Keypair
 * @param baseMint - 卖出的代币的 Mint
 * @param quoteMint - 报价代币的 Mint
 * @param amount - 要卖出的数量（字符串形式）
 * @param targetPool - 目标池子的 ID（string 格式）
 * @returns 如果构造失败，则返回 null
 */
export async function getSellTx(
    solanaConnection: Connection,
    wallet: Keypair,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    amount: string,
    targetPool: string,
) {
  try {
    // 获取 baseMint 的关联账户地址
    const tokenAta = await getAssociatedTokenAddress(baseMint, wallet.publicKey);
    // 查询关联账户的余额
    const tokenBal = await solanaConnection.getTokenAccountBalance(tokenAta);
    if (!tokenBal || tokenBal.value.uiAmount == 0) return null;

    const balance = tokenBal.value.amount;
    const decimals = tokenBal.value.decimals;

    // 构造 Token 和 TokenAmount 对象
    const baseToken = new Token(TOKEN_PROGRAM_ID, baseMint, decimals);
    const quoteToken = new Token(TOKEN_PROGRAM_ID, quoteMint, 9);
    const baseTokenAmount = new TokenAmount(baseToken, amount);
    const slippage = new Percent(99, 100);

    // 获取当前钱包的所有代币账户
    const walletTokenAccounts = await getWalletTokenAccount(solanaConnection, wallet.publicKey);

    // 生成卖出指令（目标输出为 quoteToken）
    const instructions = await swapOnlyAmm(solanaConnection, {
      outputToken: quoteToken,
      targetPool,
      inputTokenAmount: baseTokenAmount,
      slippage,
      walletTokenAccounts,
      wallet: wallet,
    });

    // 构建简单交易（VersionedTransaction）
    const willSendTx = (
        await buildSimpleTransaction({
          connection: solanaConnection,
          makeTxVersion: TxVersion.V0,
          payer: wallet.publicKey,
          innerTransactions: instructions,
          addLookupTableInfo: LOOKUP_TABLE_CACHE,
        })
    )[0];

    if (willSendTx instanceof VersionedTransaction) {
      willSendTx.sign([wallet]);
      return willSendTx;
    }
    return null;
  } catch (error) {
    console.log('Error in selling token');
    return null;
  }
}

/**
 * 使用 Jupiter API 进行买入操作
 * @param wallet - 当前操作的钱包 Keypair
 * @param baseMint - 要买入的代币的 Mint
 * @param amount - 要买入的数量
 * @returns 返回一个版本化交易对象，如果构造失败则返回 null
 */
export const getBuyTxWithJupiter = async (wallet: Keypair, baseMint: PublicKey, amount: number) => {
  try {
    // 将要买入的数量转化为 lamports
    const lamports = Math.floor(amount * 10 ** 9);

    // 调用 Jupiter 的 quote 接口，获取报价信息
    const quoteResponse = await (
        await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${baseMint.toBase58()}&amount=${lamports}&slippageBps=100`,
        )
    ).json();

    // 调用 swap 接口，获取序列化后的交易（swapTransaction）
    const { swapTransaction } = await (
        await fetch('https://quote-api.jup.ag/v6/swap', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            quoteResponse,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 52000,
          }),
        })
    ).json();

    // 反序列化交易
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // 签名交易并返回
    transaction.sign([wallet]);
    return transaction;
  } catch (error) {
    console.log('Failed to get buy transaction');
    return null;
  }
};

/**
 * 使用 Jupiter API 进行卖出操作
 * @param wallet - 当前操作的钱包 Keypair
 * @param baseMint - 要卖出的代币的 Mint
 * @param amount - 卖出的数量（string 形式，单位为最小单位）
 * @returns 返回版本化交易对象，如果构造失败则返回 null
 */
export const getSellTxWithJupiter = async (wallet: Keypair, baseMint: PublicKey, amount: string) => {
  try {
    // 调用 Jupiter 的 quote 接口，获取报价
    const quoteResponse = await (
        await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=${baseMint.toBase58()}&outputMint=So11111111111111111111111111111111111111112&amount=${amount}&slippageBps=100`,
        )
    ).json();

    // 调用 swap 接口获取序列化交易
    const { swapTransaction } = await (
        await fetch('https://quote-api.jup.ag/v6/swap', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            quoteResponse,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 52000,
          }),
        })
    ).json();

    // 反序列化交易
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // 签名交易并返回
    transaction.sign([wallet]);
    return transaction;
  } catch (error) {
    console.log('Failed to get sell transaction');
    return null;
  }
};