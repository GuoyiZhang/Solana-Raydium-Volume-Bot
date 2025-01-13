import { Logger } from 'pino';
// 从 pino 库中导入 Logger 类型，用于记录日志

import dotenv from 'dotenv';
// 从 dotenv 库中导入 dotenv，用于加载环境变量

import fs from 'fs';
// Node.js 内置文件系统模块，用于读写文件

dotenv.config();
// 调用 config() 方法加载 .env 文件中的环境变量

/**
 * retrieveEnvVariable 函数
 * 从环境变量中读取指定名称的变量，如果不存在则退出程序
 * @param variableName 需要读取的环境变量名称
 * @param logger 日志工具对象（pino 的实例）
 * @returns 返回读取到的环境变量值
 */
export const retrieveEnvVariable = (variableName: string, logger: Logger) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    console.log(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

// 定义 JSON 文件中的数据结构类型
export interface Data {
  privateKey: string;      // 私钥
  pubkey: string;          // 公钥
  solBalance: number | null;   // SOL 余额
  tokenBuyTx: string | null;   // 购买交易记录
  tokenSellTx: string | null;  // 卖出交易记录
}

/**
 * randVal 函数
 * 生成一定数量（count）的随机数，它们的和为 total，在指定区间 [min, max] 内
 * 如果 isEven 为 true，则返回的所有值相等；否则，会进行随机配对调整
 * @param min 最小值
 * @param max 最大值
 * @param count 数量
 * @param total 总和
 * @param isEven 是否所有值相等
 * @returns 返回随机分配好的数组
 */
export const randVal = (min: number, max: number, count: number, total: number, isEven: boolean): number[] => {
  const arr: number[] = Array(count).fill(total / count);
  if (isEven) return arr;

  if (max * count < total) throw new Error('Invalid input: max * count must be greater than or equal to total.');
  if (min * count > total) throw new Error('Invalid input: min * count must be less than or equal to total.');
  const average = total / count;

  // 以两两配对的方式进行随机加减调整
  for (let i = 0; i < count; i += 2) {
    // 随机生成一个调整值，范围为 [0, Math.min(max - average, average - min)]
    const adjustment = Math.random() * Math.min(max - average, average - min);
    // 对两个元素进行正负调整
    arr[i] += adjustment;
    arr[i + 1] -= adjustment;
  }
  return arr;
};

/**
 * saveDataToFile 函数
 * 将新数据（数组）保存到指定文件（JSON 格式）中，如果文件原先存在，则合并旧数据与新数据
 * @param newData 要保存的新数据数组
 * @param filePath 文件路径，默认为 'data.json'
 */
export const saveDataToFile = (newData: Data[], filePath: string = 'data.json') => {
  try {
    let existingData: Data[] = [];

    // 检查文件是否存在
    if (fs.existsSync(filePath)) {
      // 如果文件存在，则读取其中的内容
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      existingData = JSON.parse(fileContent);
    }

    // 将新数据合并进已有数据
    existingData.push(...newData);

    // 将合并好的数据写回文件
    fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2));
  } catch (error) {
    // 如果写文件失败，尝试删除文件并重新创建
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`File ${filePath} deleted and create new file.`);
      }
      fs.writeFileSync(filePath, JSON.stringify(newData, null, 2));
      console.log('File is saved successfully.');
    } catch (error) {
      console.log('Error saving data to JSON file:', error);
    }
  }
};

/**
 * sleep 函数
 * @param ms 延迟毫秒数
 * @returns 返回一个 Promise，用于在异步函数中做延迟
 */
export const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * deleteConsoleLines 函数
 * 从终端中向上删除指定行数
 * @param numLines 要删除的行数
 */
export function deleteConsoleLines(numLines: number) {
  for (let i = 0; i < numLines; i++) {
    process.stdout.moveCursor(0, -1); // 光标向上移动一行
    process.stdout.clearLine(-1);     // 清除该行内容
  }
}

/**
 * readJson 函数
 * 从指定 JSON 文件中读取并解析 Data 数组
 * 如果文件不存在，则创建一个空的 JSON 文件
 * @param filename 文件名，默认 'data.json'
 * @returns 返回解析后的 Data 数组
 */
export function readJson(filename: string = 'data.json'): Data[] {
  if (!fs.existsSync(filename)) {
    // 如果文件不存在，则创建一个空数组写入文件
    fs.writeFileSync(filename, '[]', 'utf-8');
  }
  const data = fs.readFileSync(filename, 'utf-8');
  return JSON.parse(data) as Data[];
}

/**
 * writeJson 函数
 * 将 Data 数组写入指定 JSON 文件
 * @param data 要写入的 Data 数组
 * @param filename 文件名，默认 'data.json'
 */
export function writeJson(data: Data[], filename: string = 'data.json'): void {
  fs.writeFileSync(filename, JSON.stringify(data, null, 4), 'utf-8');
}

/**
 * editJson 函数
 * 通过传入部分 Data（Partial<Data>），根据 pubkey 匹配并更新指定条目的数据
 * @param newData 部分更新数据，至少需要包含 pubkey
 * @param filename 要编辑的 JSON 文件，默认 'data.json'
 */
export function editJson(newData: Partial<Data>, filename: string = 'data.json'): void {
  if (!newData.pubkey) {
    console.log('Pubkey is not prvided as an argument');
    return;
  }
  const wallets = readJson(filename);
  // 根据 pubkey 查找相应的数据
  const index = wallets.findIndex((wallet) => wallet.pubkey === newData.pubkey);

  // 如果找到了，则进行合并更新
  if (index !== -1) {
    wallets[index] = { ...wallets[index], ...newData };
    writeJson(wallets, filename);
  } else {
    // 如果没有找到对应的 pubkey，则输出错误
    console.error(`Pubkey ${newData.pubkey} does not exist.`);
  }
}