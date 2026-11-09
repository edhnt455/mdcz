export const DEFAULT_SERVER_PORT = 3838;
export const DEFAULT_SERVER_HOST = "127.0.0.1";

export const parsePort = (value: string | undefined): number => {
  if (!value) {
    return DEFAULT_SERVER_PORT;
  }

  const normalizedValue = value.trim();
  if (!/^\d+$/.test(normalizedValue)) {
    throw new Error(`PORT 值无效：${value}`);
  }

  const port = Number(normalizedValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 值无效：${value}`);
  }

  return port;
};

export const parseHost = (value: string | undefined): string => {
  if (!value) {
    return DEFAULT_SERVER_HOST;
  }

  const normalizedValue = value.trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(normalizedValue) || normalizedValue.length > 253) {
    throw new Error(`MDCZ_HOST 值无效：${value}`);
  }

  return normalizedValue;
};
