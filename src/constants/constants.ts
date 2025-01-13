import { logger, retrieveEnvVariable } from '../utils';
// 从自定义工具模块中导入日志工具 logger 和环境变量获取工具 retrieveEnvVariable

// 读取私钥，从环境变量中获取
export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);
// 读取 Solana RPC 端点
export const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
// 读取 Solana RPC WebSocket 端点
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);

// 是否启用随机买入
export const IS_RANDOM = retrieveEnvVariable('IS_RANDOM', logger) === 'true';
// 是否启用代币路由
export const SWAP_ROUTING = retrieveEnvVariable('SWAP_ROUTING', logger) === 'true';
// 指定分发金额
export const DISTRIBUTION_AMOUNT = Number(retrieveEnvVariable('DISTRIBUTION_AMOUNT', logger));
// 固定买入金额
export const BUY_AMOUNT = Number(retrieveEnvVariable('BUY_AMOUNT', logger));
// 随机买入区间的上限
export const BUY_UPPER_AMOUNT = Number(retrieveEnvVariable('BUY_UPPER_AMOUNT', logger));
// 随机买入区间的下限
export const BUY_LOWER_AMOUNT = Number(retrieveEnvVariable('BUY_LOWER_AMOUNT', logger));

// 最小买入间隔
export const BUY_INTERVAL_MIN = Number(retrieveEnvVariable('BUY_INTERVAL_MIN', logger));
// 最大买入间隔
export const BUY_INTERVAL_MAX = Number(retrieveEnvVariable('BUY_INTERVAL_MAX', logger));

// 卖出次数限制（全部卖光的分批次数）
export const SELL_ALL_BY_TIMES = Number(retrieveEnvVariable('SELL_ALL_BY_TIMES', logger));
// 卖出百分比（单次卖出占比）
export const SELL_PERCENT = Number(retrieveEnvVariable('SELL_PERCENT', logger));

// 分发钱包数量
export const DISTRIBUTE_WALLET_NUM = Number(retrieveEnvVariable('DISTRIBUTE_WALLET_NUM', logger));
// 检查余额的时间间隔
export const CHECK_BAL_INTERVAL = Number(retrieveEnvVariable('CHECK_BAL_INTERVAL', logger));

// 钱包数量
export const WALLET_NUM = Number(retrieveEnvVariable('WALLET_NUM', logger));

// 交易手续费
export const TX_FEE = Number(retrieveEnvVariable('TX_FEE', logger));

// 要交易的代币 Mint 地址
export const TOKEN_MINT = retrieveEnvVariable('TOKEN_MINT', logger);
// Raydium 池子 ID
export const POOL_ID = retrieveEnvVariable('POOL_ID', logger);

// 日志级别
export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger);

// 附加费用（如操作费、Gas 预留等）
export const ADDITIONAL_FEE = Number(retrieveEnvVariable('ADDITIONAL_FEE', logger));

// 以下为注释掉的示例常量，可自行开启
// export const JITO_KEY = retrieveEnvVariable('JITO_KEY', logger)
// export const BLOCKENGINE_URL = retrieveEnvVariable('BLOCKENGINE_URL', logger)
// export const JITO_FEE = Number(retrieveEnvVariable('JITO_FEE', logger))