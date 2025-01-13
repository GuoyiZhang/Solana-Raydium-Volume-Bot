import assert from 'assert';
// 使用 assert 库来进行断言，用于验证代码逻辑。

import {
  jsonInfo2PoolKeys,                // 将池信息 JSON 转换为 Raydium 池的关键信息对象
  Liquidity,                        // Raydium SDK 的流动性模块
  LiquidityPoolKeys,                // 流动性池的关键数据结构
  Percent,                          // 百分比工具，常用于滑点处理
  Token,                            // 代币类，用于表示链上的各种代币
  TokenAmount,                      // 代币数量类，包含代币信息和数量
  ApiPoolInfoV4,                    // 用于描述 V4 版本流动性池信息的数据结构
  LIQUIDITY_STATE_LAYOUT_V4,        // Raydium V4 流动性池的账户布局
  MARKET_STATE_LAYOUT_V3,           // Raydium V3 市场账户布局
  Market,                           // Raydium 的市场模块
  SPL_MINT_LAYOUT,                  // SPL Token 的 Mint 信息布局
  SPL_ACCOUNT_LAYOUT,               // SPL Token 的账户信息布局
  TokenAccount,                     // 用于表示 SPL Token 账户信息的类型
  TxVersion,                        // 交易版本枚举
  buildSimpleTransaction,           // 构建简单交易（VersionedTransaction）的工具
  LOOKUP_TABLE_CACHE,               // 查找表缓存，用于添加给交易的查找表信息
} from '@raydium-io/raydium-sdk';

import { PublicKey, Keypair, Connection, VersionedTransaction } from '@solana/web3.js';
// 导入 Solana Web3.js 的核心类和方法。

import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getMint } from '@solana/spl-token';
// SPL-Token 库，用于管理代币 Mint、代币账户以及关联账户。

import { TX_FEE } from '../constants';
// 自定义常量文件，包含交易手续费（或者其他配置）。

// 类型声明：WalletTokenAccounts 用于存储钱包里的 TokenAccount 数组。
type WalletTokenAccounts = Awaited<ReturnType<typeof getWalletTokenAccount>>;

// 类型声明：TestTxInputInfo 用于在 swapOnlyAmm 函数中接收的输入信息。
type TestTxInputInfo = {
  outputToken: Token;               // 目标输出代币
  targetPool: string;               // 目标池子 ID
  inputTokenAmount: TokenAmount;    // 输入代币数量
  slippage: Percent;                // 滑点
  walletTokenAccounts: WalletTokenAccounts; // 当前钱包的代币账户列表
  wallet: Keypair;                  // 当前操作的钱包密钥对
};

// 获取指定钱包的所有 Token Account 信息
async function getWalletTokenAccount(connection: Connection, wallet: PublicKey): Promise<TokenAccount[]> {
  // 获取与钱包相关的所有 Token 账户
  const walletTokenAccount = await connection.getTokenAccountsByOwner(wallet, {
    programId: TOKEN_PROGRAM_ID,
  });
  // 将账户信息解码为 SPL_ACCOUNT_LAYOUT，然后映射成 TokenAccount 类型对象
  return walletTokenAccount.value.map((i) => ({
    pubkey: i.pubkey,
    programId: i.account.owner,
    accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
  }));
}

// 进行 AMM 交换（基于 Raydium 池）
// 传入包含池子信息、代币信息、滑点等数据的 input，并返回生成的交易指令
async function swapOnlyAmm(connection: Connection, input: TestTxInputInfo) {
  // -------- pre-action: get pool info --------
  const targetPoolInfo = await formatAmmKeysById(connection, input.targetPool);
  assert(targetPoolInfo, 'cannot find the target pool');
  // 将 ApiPoolInfoV4 转换为 LiquidityPoolKeys
  const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys;

  // -------- step 1: compute amount out --------
  // 计算兑换输出数量以及最小输出数量（结合滑点）
  const { amountOut, minAmountOut } = Liquidity.computeAmountOut({
    poolKeys: poolKeys,
    poolInfo: await Liquidity.fetchInfo({ connection, poolKeys }),
    amountIn: input.inputTokenAmount,
    currencyOut: input.outputToken,
    slippage: input.slippage,
  });

  // -------- step 2: create instructions by SDK function --------
  // 使用 Raydium SDK 生成交易指令
  const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
    connection,
    poolKeys,
    userKeys: {
      tokenAccounts: input.walletTokenAccounts,
      owner: input.wallet.publicKey,
    },
    amountIn: input.inputTokenAmount,
    amountOut: minAmountOut,
    fixedSide: 'in',
    makeTxVersion: TxVersion.V0,
    computeBudgetConfig: {
      microLamports: 12_000 * TX_FEE, // 可选的执行预算设置
      units: 100_000,
    },
  });
  return innerTransactions; // 返回交易指令数组
}

// 通过池子 ID 获取池子信息并格式化为 ApiPoolInfoV4
export async function formatAmmKeysById(connection: Connection, id: string): Promise<ApiPoolInfoV4> {
  const account = await connection.getAccountInfo(new PublicKey(id));
  if (account === null) throw Error(' get id info error ');
  // 解码池子状态
  const info = LIQUIDITY_STATE_LAYOUT_V4.decode(account.data);

  // 获取市场相关的信息
  const marketId = info.marketId;
  const marketAccount = await connection.getAccountInfo(marketId);
  if (marketAccount === null) throw Error(' get market info error');
  const marketInfo = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data);

  // 获取 LP Token Mint 信息
  const lpMint = info.lpMint;
  const lpMintAccount = await connection.getAccountInfo(lpMint);
  if (lpMintAccount === null) throw Error(' get lp mint info error');
  const lpMintInfo = SPL_MINT_LAYOUT.decode(lpMintAccount.data);

  // 返回整理后的池子信息
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

// 基于 Raydium AMM 进行买入操作，返回已签名的交易对象
export async function getBuyTx(
    solanaConnection: Connection,
    wallet: Keypair,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    amount: number,
    targetPool: string,
) {
  // 获取目标代币（baseMint）的 mint 信息
  const baseInfo = await getMint(solanaConnection, baseMint);
  if (baseInfo == null) {
    return null;
  }
  const baseDecimal = baseInfo.decimals;

  // 初始化代币对象
  const baseToken = new Token(TOKEN_PROGRAM_ID, baseMint, baseDecimal);
  const quoteToken = new Token(TOKEN_PROGRAM_ID, quoteMint, 9);

  // 构造输入代币数量（卖出多少 quoteToken）
  const quoteTokenAmount = new TokenAmount(quoteToken, Math.floor(amount * 10 ** 9));
  const slippage = new Percent(100, 100);

  // 获取钱包的所有代币账户
  const walletTokenAccounts = await getWalletTokenAccount(solanaConnection, wallet.publicKey);

  // 生成买入指令（目标是 baseToken）
  const instructions = await swapOnlyAmm(solanaConnection, {
    outputToken: baseToken,
    targetPool,
    inputTokenAmount: quoteTokenAmount,
    slippage,
    walletTokenAccounts,
    wallet: wallet,
  });

  // 构造并获取交易
  const willSendTx = (
      await buildSimpleTransaction({
        connection: solanaConnection,
        makeTxVersion: TxVersion.V0,
        payer: wallet.publicKey,
        innerTransactions: instructions,
        addLookupTableInfo: LOOKUP_TABLE_CACHE,
      })
  )[0];

  // 检查交易类型并进行签名
  if (willSendTx instanceof VersionedTransaction) {
    willSendTx.sign([wallet]);
    return willSendTx;
  }
  return null;
}

// 基于 Raydium AMM 进行卖出操作，返回已签名的交易对象
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
    // 查询余额
    const tokenBal = await solanaConnection.getTokenAccountBalance(tokenAta);
    if (!tokenBal || tokenBal.value.uiAmount == 0) return null;

    const balance = tokenBal.value.amount;
    const decimals = tokenBal.value.decimals;

    // 构造 Token 和 TokenAmount
    const baseToken = new Token(TOKEN_PROGRAM_ID, baseMint, decimals);
    const quoteToken = new Token(TOKEN_PROGRAM_ID, quoteMint, 9);
    const baseTokenAmount = new TokenAmount(baseToken, amount);
    const slippage = new Percent(99, 100);

    // 获取钱包的所有代币账户
    const walletTokenAccounts = await getWalletTokenAccount(solanaConnection, wallet.publicKey);

    // 生成卖出指令（目标是 quoteToken）
    const instructions = await swapOnlyAmm(solanaConnection, {
      outputToken: quoteToken,
      targetPool,
      inputTokenAmount: baseTokenAmount,
      slippage,
      walletTokenAccounts,
      wallet: wallet,
    });

    // 构造并获取交易
    const willSendTx = (
        await buildSimpleTransaction({
          connection: solanaConnection,
          makeTxVersion: TxVersion.V0,
          payer: wallet.publicKey,
          innerTransactions: instructions,
          addLookupTableInfo: LOOKUP_TABLE_CACHE,
        })
    )[0];

    // 检查交易类型并签名
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

// 使用 Jupiter API 进行买入操作
export const getBuyTxWithJupiter = async (wallet: Keypair, baseMint: PublicKey, amount: number) => {
  try {
    // 将买入金额转换为 lamports
    const lamports = Math.floor(amount * 10 ** 9);

    // 调用 Jupiter 的 quote 接口，获取报价数据
    const quoteResponse = await (
        await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${baseMint.toBase58()}&amount=${lamports}&slippageBps=100`,
        )
    ).json();

    // 调用 swap 接口获取序列化的交易（Base64 格式）
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

    // 签名交易
    transaction.sign([wallet]);
    return transaction;
  } catch (error) {
    console.log('Failed to get buy transaction');
    return null;
  }
};

// 使用 Jupiter API 进行卖出操作
export const getSellTxWithJupiter = async (wallet: Keypair, baseMint: PublicKey, amount: string) => {
  try {
    // 调用 Jupiter 的 quote 接口，获取报价数据
    const quoteResponse = await (
        await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=${baseMint.toBase58()}&outputMint=So11111111111111111111111111111111111111112&amount=${amount}&slippageBps=100`,
        )
    ).json();

    // 调用 swap 接口获取序列化的交易（Base64 格式）
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

    // 签名交易
    transaction.sign([wallet]);
    return transaction;
  } catch (error) {
    console.log('Failed to get sell transaction');
    return null;
  }
};