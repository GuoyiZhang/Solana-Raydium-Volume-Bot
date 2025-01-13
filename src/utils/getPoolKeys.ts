import { Liquidity, MARKET_STATE_LAYOUT_V3, Market } from '@raydium-io/raydium-sdk';
// 引入 Raydium SDK 中的流动性和市场相关模块。

import { Commitment, Connection, PublicKey } from '@solana/web3.js';
// Solana Web3.js，用于和节点连接，并提供公共密钥类型等。

import dotenv from 'dotenv';
dotenv.config();
// 加载环境变量。

/**
 * PoolKeys 类封装了获取池子相关信息的静态方法，包括：
 * 1. 通过 baseMint、quoteMint 查找对应的 OpenBook Market ID；
 * 2. 获取指定 Market 的信息；
 * 3. 生成 Raydium V4 池子的关键参数；
 * 4. 获取最终拼装好的 Pool Key 信息（包括 LP Mint、Vault 地址等）。
 */
export class PoolKeys {
  // Solana 的 Native SOL 的 Mint 地址
  static SOLANA_ADDRESS = 'So11111111111111111111111111111111111111112';
  // Raydium V4 池子程序地址
  static RAYDIUM_POOL_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  // OpenBook 程序地址（原 Serum V4）
  static OPENBOOK_ADDRESS = 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX';
  // SOL 的小数位数
  static SOL_DECIMALS = 9;

  /**
   * 通过在 OpenBook 程序中搜索 baseMint 和 quoteMint 来查找 Market ID。
   * @param connection - 与 Solana 节点的连接
   * @param baseMint - 交易对的基础代币的 Mint
   * @param quoteMint - 交易对的报价代币的 Mint
   * @param commitment - 查询数据的确认级别
   * @returns 返回第一个匹配条件的 Market ID
   */
  static async fetchMarketId(
      connection: Connection,
      baseMint: PublicKey,
      quoteMint: PublicKey,
      commitment: Commitment,
  ) {
    // 第一次在 Market 合约中查找 (baseMint, quoteMint) 的匹配
    let accounts = await connection.getProgramAccounts(
        new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
        {
          commitment,
          filters: [
            { dataSize: MARKET_STATE_LAYOUT_V3.span }, // 筛选出数据长度与 MarketStateLayout 相匹配的账户
            {
              memcmp: {
                offset: MARKET_STATE_LAYOUT_V3.offsetOf('baseMint'),
                bytes: baseMint.toBase58(),
              },
            },
            {
              memcmp: {
                offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
                bytes: quoteMint.toBase58(),
              },
            },
          ],
        },
    );

    // 如果第一次查询未果，再尝试互换 base/quote 位置
    if (!accounts)
      accounts = await connection.getProgramAccounts(new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'), {
        commitment,
        filters: [
          { dataSize: MARKET_STATE_LAYOUT_V3.span },
          {
            memcmp: {
              offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
              bytes: baseMint.toBase58(),
            },
          },
          {
            memcmp: {
              offset: MARKET_STATE_LAYOUT_V3.offsetOf('baseMint'),
              bytes: quoteMint.toBase58(),
            },
          },
        ],
      });

    console.log(accounts);
    // 解码得到 MarketStateLayout，再取第一个对应账户的 ownAddress
    return accounts.map(({ account }) => MARKET_STATE_LAYOUT_V3.decode(account.data))[0].ownAddress;
  }

  /**
   * 通过 marketId 获取 Market 的详细信息
   * @param connection - 与 Solana 节点的连接
   * @param marketId - 目标市场的 PublicKey
   * @returns 解码后的 MarketState
   */
  static async fetchMarketInfo(connection: Connection, marketId: PublicKey) {
    const marketAccountInfo = await connection.getAccountInfo(marketId, 'processed');
    if (!marketAccountInfo) {
      throw new Error('Failed to fetch market info for market id ' + marketId.toBase58());
    }

    return MARKET_STATE_LAYOUT_V3.decode(marketAccountInfo.data);
  }

  /**
   * 使用 Raydium 的 Liquidity.getAssociatedPoolKeys 来生成 V4 池子的信息
   * @param baseMint - 基础代币 Mint
   * @param quoteMint - 报价代币 Mint
   * @param marketID - 上一步查到的 Market ID
   * @returns { poolInfo }：包含流动性池相关参数（如 baseVault、quoteVault、lpMint 等）
   */
  static async generateV4PoolInfo(baseMint: PublicKey, quoteMint: PublicKey, marketID: PublicKey) {
    const poolInfo = Liquidity.getAssociatedPoolKeys({
      version: 4,                // Raydium V4
      marketVersion: 3,          // Market 版本（OpenBook/Serum V3）
      baseMint: baseMint,        // 基础代币
      quoteMint: quoteMint,      // 报价代币
      baseDecimals: 0,           // 这里填 0 是占位，通常要根据实际代币信息填写
      quoteDecimals: this.SOL_DECIMALS,
      programId: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), // Raydium V4 程序 ID
      marketId: marketID,        // 对应的 OpenBook Market
      marketProgramId: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'), // OpenBook 程序 ID
    });

    return { poolInfo };
  }

  /**
   * 获取完整的 PoolKey 信息，包括 LP Mint、Vault 等
   * @param connection - Solana 连接对象
   * @param baseMint - 基础代币 Mint
   * @param quoteMint - 报价代币 Mint
   * @returns 包含池子相关地址和信息的对象
   */
  static async fetchPoolKeyInfo(connection: Connection, baseMint: PublicKey, quoteMint: PublicKey) {
    // 1. 首先获取 Market Id
    const marketId = await this.fetchMarketId(connection, baseMint, quoteMint, 'confirmed');

    // 2. 生成 Raydium V4 池子信息
    const V4PoolInfo = await this.generateV4PoolInfo(baseMint, quoteMint, marketId);

    // 3. 获取 LP Mint 的解析后信息（以确认 LP Token 的 decimals）
    const lpMintInfo = (await connection.getParsedAccountInfo(V4PoolInfo.poolInfo.lpMint, 'confirmed')) as MintInfo;

    // 4. 组装返回数据
    return {
      id: V4PoolInfo.poolInfo.id,                 // 池子的唯一 ID
      marketId: marketId,                         // Market ID
      baseMint: baseMint,
      quoteMint: quoteMint,
      baseVault: V4PoolInfo.poolInfo.baseVault,   // 基础代币的 Vault
      quoteVault: V4PoolInfo.poolInfo.quoteVault, // 报价代币的 Vault
      lpMint: V4PoolInfo.poolInfo.lpMint,         // LP Token Mint
      // baseDecimals: baseDecimals,               // 这里注释掉了，需要实际代币 decimals
      quoteDecimals: this.SOL_DECIMALS,           // 假定 quote 是 SOL
      lpDecimals: lpMintInfo.value.data.parsed.info.decimals, // LP Token 的小数位
      version: 4,                                 // Raydium Pool V4
      programId: new PublicKey(this.RAYDIUM_POOL_V4_PROGRAM_ID), // Raydium V4 程序地址
      authority: V4PoolInfo.poolInfo.authority,   // 池子授权地址
      openOrders: V4PoolInfo.poolInfo.openOrders, // OpenOrders PDA
      targetOrders: V4PoolInfo.poolInfo.targetOrders, // TargetOrders PDA
      withdrawQueue: new PublicKey('11111111111111111111111111111111'), // 假地址占位
      lpVault: new PublicKey('11111111111111111111111111111111'),       // 假地址占位
      marketVersion: 3,                           // 当前 Market 版本（V3）
      marketProgramId: new PublicKey(this.OPENBOOK_ADDRESS), // OpenBook 程序地址
      marketAuthority: Market.getAssociatedAuthority({
        programId: new PublicKey(this.OPENBOOK_ADDRESS),
        marketId: marketId,
      }).publicKey, // 对应 Market 的授权 PDA
      // 下面这些 Market 相关信息如果需要，可通过 fetchMarketInfo 拉取并填充
      // marketBaseVault: marketInfo.baseVault,
      // marketQuoteVault: marketInfo.quoteVault,
      // marketBids: marketInfo.bids,
      // marketAsks: marketInfo.asks,
      // marketEventQueue: marketInfo.eventQueue,
      lookupTableAccount: PublicKey.default, // 默认值（未使用的情况）
    };
  }
}

// 解析后的 Mint 信息类型，包含 decimals
interface MintInfo {
  value: {
    data: {
      parsed: {
        info: {
          decimals: number;
        };
      };
    };
  };
}