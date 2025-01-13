import pino from 'pino';

// 创建一个 Pino 的传输层，用于美化日志输出
const transport = pino.transport({
    target: 'pino-pretty', // 使用 pino-pretty 插件来美化日志
});

// 初始化 Pino 日志记录器
export const logger = pino(
    {
        level: 'info',       // 默认的日志级别为 info
        redact: ['poolKeys'], // 在日志中隐藏名为 'poolKeys' 的字段
        serializers: {
            // 使用 Pino 内置的错误序列化器
            error: pino.stdSerializers.err,
        },
        base: undefined,     // 不在日志中添加默认的 base 字段（如 pid, hostname 等）
    },
    transport,
);