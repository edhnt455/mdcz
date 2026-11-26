import { BlockList, isIP } from "node:net";

const localNetworks = new BlockList();
localNetworks.addSubnet("127.0.0.0", 8);
localNetworks.addSubnet("10.0.0.0", 8);
localNetworks.addSubnet("172.16.0.0", 12);
localNetworks.addSubnet("192.168.0.0", 16);
localNetworks.addSubnet("169.254.0.0", 16);
localNetworks.addSubnet("100.64.0.0", 10);
localNetworks.addAddress("::1", "ipv6");
localNetworks.addSubnet("fc00::", 7, "ipv6");
localNetworks.addSubnet("fe80::", 10, "ipv6");

export const isLocalNetworkUrl = (url: string): boolean => {
  const host = new URL(url).hostname.replace(/^\[|\]$|\.$/gu, "").toLowerCase();
  const family = isIP(host);
  if (family) return localNetworks.check(host, family === 6 ? "ipv6" : "ipv4");
  return !host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local");
};
