import { Connection, VersionedTransaction } from '@solana/web3.js';
// 从 Solana Web3.js 库中导入 Connection 和 VersionedTransaction，用于区块链连接和处理版本化交易。

import { RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from '../constants';
// 从项目常量文件中导入 RPC 地址和 WebSocket 地址。

/**
 * 定义 Blockhash 接口
 * 描述了 Solana 区块哈希和其对应的区块高度，用于交易确认。
 */
interface Blockhash {
  blockhash: string;              // 当前区块哈希
  lastValidBlockHeight: number;   // 与该区块哈希对应的有效区块高度
}

/**
 * execute 函数
 * 1. 通过传入的 VersionedTransaction 发送原始交易数据到链上（sendRawTransaction）。
 * 2. 使用确认参数（lastValidBlockHeight + blockhash）进行 confirmTransaction。
 * 3. 根据确认结果判断交易是否执行成功，如果成功则输出相应消息和 Solscan 链接。
 *
 * @param transaction - 需要执行的版本化交易对象
 * @param latestBlockhash - 区块哈希和有效区块高度，用于确认交易
 * @param isBuy - 是否是买入交易，用于在日志中区分买/卖动作，默认为 true
 * @returns 如果交易确认失败返回空字符串；成功则返回交易签名
 */
export const execute = async (
    transaction: VersionedTransaction,
    latestBlockhash: Blockhash,
    isBuy: boolean = true,
) => {
  // 使用指定的 RPC_ENDPOINT 和 RPC_WEBSOCKET_ENDPOINT 初始化连接
  const solanaConnection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  });

  // 发送原始交易数据到节点（跳过预检 skipPreflight）
  const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });

  // 基于返回的区块哈希和最后有效区块高度，确认交易
  const confirmation = await solanaConnection.confirmTransaction({
    signature,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    blockhash: latestBlockhash.blockhash,
  });

  // 检查确认结果，如果有错误则返回空字符串表示失败
  if (confirmation.value.err) {
    console.log('Confirmation error');
    return '';
  } else {
    // 如果确认通过，根据 isBuy 标记打印相应日志
    if (isBuy) {
      console.log(`Success in buy transaction: https://solscan.io/tx/${signature}`);
    } else {
      console.log(`Success in Sell transaction: https://solscan.io/tx/${signature}`);
    }
  }

  // 返回交易签名
  return signature;
};