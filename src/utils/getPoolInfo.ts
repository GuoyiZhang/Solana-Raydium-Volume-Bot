import {
  Liquidity,                   // Raydium 流动性相关模块
  LIQUIDITY_STATE_LAYOUT_V4,   // Raydium V4 流动性池状态布局
  MARKET_STATE_LAYOUT_V3,      // Raydium/Serum Market V3 状态布局
  SPL_MINT_LAYOUT,             // SPL Token Mint 布局
  ApiPoolInfoV4,               // 表示 Raydium V4 池子信息的数据结构
  Market,                      // Raydium 中 Market 相关方法
} from '@raydium-io/raydium-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
// NATIVE_MINT 是系统提供的 SOL 代币的伪 mint 地址。
import { Connection, PublicKey } from '@solana/web3.js';
// Solana Web3.js，用于获取链上账户信息、发送交易等。

/**
 * 通过池子 ID 解析池子相关的关键信息，返回符合 ApiPoolInfoV4 接口的对象。
 * @param id - Raydium 池子在链上的公钥（String 格式）
 * @param connection - 与 Solana 节点的连接对象
 */
async function _formatAmmKeysById(id: string, connection: Connection): Promise<ApiPoolInfoV4> {
  // 根据池子 ID 获取账户信息
  const account = await connection.getAccountInfo(new PublicKey(id));
  if (account === null) throw Error(' get id info error ');

  // 解码流动性池状态（V4）
  const info = LIQUIDITY_STATE_LAYOUT_V4.decode(account.data);

  // 获取 Market 相关信息
  const marketId = info.marketId;
  const marketAccount = await connection.getAccountInfo(marketId);
  if (marketAccount === null) throw Error(' get market info error');
  const marketInfo = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data);

  // 获取 LP Mint 信息，用于获取 lpDecimals
  const lpMint = info.lpMint;
  const lpMintAccount = await connection.getAccountInfo(lpMint);
  if (lpMintAccount === null) throw Error(' get lp mint info error');
  const lpMintInfo = SPL_MINT_LAYOUT.decode(lpMintAccount.data);

  // 返回符合 ApiPoolInfoV4 的对象
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
 * 调用 dexscreener 的接口，获取指定 baseMint 的 Raydium 交易对地址，
 * 再调用 `_formatAmmKeysById` 函数获取 Raydium 池子的关键信息。
 * @param connection - 与 Solana 节点的连接对象
 * @param baseMint - 想要查询的代币的 Mint 地址
 * @returns 返回符合 ApiPoolInfoV4 接口的池子信息，或者 null（未找到池子）
 */
export const getPoolKeys = async (connection: Connection, baseMint: PublicKey) => {
  try {
    // 通过 dexscreener API 获取该 baseMint 相关的交易对信息
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${baseMint.toBase58()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    const data = await res.clone().json();

    // 如果 pairs 数组为空，说明未找到交易对
    if (data.pairs.length == 0) {
      return null;
    } else {
      // 筛选出在 Raydium 上，并且 quoteToken 是 NATIVE_MINT (SOL) 的交易对
      const raydiumPairId = data.pairs.filter(
          (pair: any) => pair.dexId === 'raydium' && pair.quoteToken.address == NATIVE_MINT.toBase58(),
      )[0].pairAddress;

      // 通过筛选出的地址（pairAddress），调用 _formatAmmKeysById 函数获取池子状态
      const poolState = await _formatAmmKeysById(raydiumPairId, connection);
      return poolState;
    }
  } catch (e) {
    console.log('error in fetching price of pool', e);
    return null;
  }
};