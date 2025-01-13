// Jito Bundling part

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
// 从 Solana Web3.js 库中导入必需的类和方法。

import { BLOCKENGINE_URL, JITO_FEE, JITO_KEY, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from '../constants';
// 从常量文件中引入 JITO 的配置参数和 RPC 端点地址。

import base58 from 'bs58';
// base58 编解码库，用于将 base58 格式的字符串转换为字节数组或相反。

import { SearcherClient, searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
// Jito SDK：SearcherClient 用于跟 Block Engine 进行交互。

import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
// Bundle 类，用于构建包含多笔交易的打包对象。

import { isError } from 'jito-ts/dist/sdk/block-engine/utils';
// 工具函数，用于判断返回对象是否为错误类型。

/**
 * 初始化一个新的 Solana Connection，用于和节点通信。
 */
const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

/**
 * bundle 函数
 * 将一组交易（txs）分批（每 3 笔交易一组）发送到 bull_dozer 函数进行处理。
 *
 * @param txs - 需要提交的交易数组
 * @param keypair - 提交者的 Keypair，用于签名交易
 * @returns 返回一个布尔值，表示打包流程是否成功
 */
export async function bundle(txs: VersionedTransaction[], keypair: Keypair) {
  try {
    // 计算需要分批的次数（每批 3 笔交易）
    const txNum = Math.ceil(txs.length / 3);
    let successNum = 0;

    // 分批处理交易
    for (let i = 0; i < txNum; i++) {
      const upperIndex = (i + 1) * 3;
      const downIndex = i * 3;
      const newTxs = [];

      // 按照区间截取新的交易数组
      for (let j = downIndex; j < upperIndex; j++) {
        if (txs[j]) newTxs.push(txs[j]);
      }

      // 将截取好的交易数组交给 bull_dozer 函数
      let success = await bull_dozer(newTxs, keypair);
      return success;
      // 注意：这里在循环中直接 return，会导致只处理第一批交易后就结束函数
      // 如果期望处理完所有批次再判断 success，则需要修改此处逻辑
    }

    // 如果实际逻辑是处理所有批次，可将下面逻辑解开或改写
    // if (successNum == txNum) return true;
    // else return false;

  } catch (error) {
    return false;
  }
}

/**
 * bull_dozer 函数
 * 使用 Jito 的 searcherClient，创建并发送一个打包交易（bundle）。
 *
 * @param txs - 交易数组
 * @param keypair - 提交者的 Keypair
 * @returns 返回一个数字（number），表示处理结果
 *          或者在本代码逻辑中，如果 onBundleResult 返回的结果 >= 1，则说明成功
 */
export async function bull_dozer(txs: VersionedTransaction[], keypair: Keypair) {
  try {
    // 设置一次打包最多包含 4 笔交易（bundleTransactionLimit）
    const bundleTransactionLimit = parseInt('4');
    // 使用 JITO_KEY 生成签名者密钥对
    const jitoKey = Keypair.fromSecretKey(base58.decode(JITO_KEY));
    // 生成 Jito 的 SearcherClient，用于和 Block Engine 交互
    const search = searcherClient(BLOCKENGINE_URL, jitoKey);

    // 构建并发送 Bundle
    await build_bundle(search, bundleTransactionLimit, txs, keypair);
    // 监听并获取打包结果
    const bundle_result = await onBundleResult(search);
    return bundle_result;
  } catch (error) {
    return 0;
  }
}

/**
 * build_bundle 函数
 * 构建包含多笔交易（txs）的 Bundle，并添加 tipTx，以提高优先级
 *
 * @param search - SearcherClient，用于和 Jito 的 Block Engine 交互
 * @param bundleTransactionLimit - 单个 Bundle 可以包含的最大交易笔数
 * @param txs - 交易数组
 * @param keypair - 提交者的 Keypair
 */
async function build_bundle(
    search: SearcherClient,
    bundleTransactionLimit: number,
    txs: VersionedTransaction[],
    keypair: Keypair,
) {
  // 随机获取一个 tipAccount，用于支付小费，以提升打包优先级
  const accounts = await search.getTipAccounts();
  const _tipAccount = accounts[Math.min(Math.floor(Math.random() * accounts.length), 3)];
  const tipAccount = new PublicKey(_tipAccount);

  // 创建一个空的 Bundle 对象，限制交易数为 bundleTransactionLimit
  const bund = new Bundle([], bundleTransactionLimit);
  // 获取最新的区块哈希，用于设置交易的 blockhash
  const resp = await solanaConnection.getLatestBlockhash('processed');

  // 将传入的交易批量添加到 bundle 中
  bund.addTransactions(...txs);

  // 添加小费交易（Tip Tx）到 bundle，用于激励快速打包
  let maybeBundle = bund.addTipTx(keypair, JITO_FEE, tipAccount, resp.blockhash);

  // 如果返回结果是错误类型，则抛出异常
  if (isError(maybeBundle)) {
    throw maybeBundle;
  }
  try {
    // 向 Jito Block Engine 发送打包请求
    await search.sendBundle(maybeBundle);
  } catch (e) {
    // 如果发送出现异常，暂时忽略
  }

  return maybeBundle;
}

/**
 * onBundleResult 函数
 * 监听 Bundle 的处理结果，当收到 accepted 时，返回 1，表示该 Bundle 被接收
 *
 * @param c - SearcherClient
 * @returns 返回一个 number，表示成功次数
 */
export const onBundleResult = (c: SearcherClient): Promise<number> => {
  let first = 0;
  let isResolved = false;

  return new Promise((resolve) => {
    // 设置一个超时，30 秒后自动返回
    setTimeout(() => {
      resolve(first);
      isResolved = true;
    }, 30000);

    // 监听 Bundle 处理结果
    c.onBundleResult(
        (result: any) => {
          if (isResolved) return first;
          // 接收和拒绝的状态
          const isAccepted = result.accepted;
          const isRejected = result.rejected;

          if (!isResolved) {
            if (isAccepted) {
              // 如果被接受，将 first+1，并返回
              first += 1;
              isResolved = true;
              resolve(first);
            }
            if (isRejected) {
              // 拒绝情况下，不做任何处理，继续等待其他结果或到超时
            }
          }
        },
        (e: any) => {
          // 如果出现错误，也不立即 reject
        },
    );
  });
};