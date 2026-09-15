import { promises as dns } from "node:dns";

export interface ZoneInspection {
  zone: string;
  nameservers: string[];
  cloudflareDelegated: boolean;
  existingRecordTypes: string[];
}

export function isCloudflareDelegation(nameservers: string[]): boolean {
  return (
    nameservers.length >= 2 &&
    nameservers.every((server) => server.toLowerCase().replace(/\.$/, "").endsWith(".ns.cloudflare.com"))
  );
}

async function present<T>(type: string, query: Promise<T[]>): Promise<string | null> {
  try {
    return (await query).length > 0 ? type : null;
  } catch {
    return null;
  }
}

export async function inspectZoneDns(zone: string): Promise<ZoneInspection> {
  const nameservers = await dns.resolveNs(zone).catch(() => []);
  const records = await Promise.all([
    present("A", dns.resolve4(zone)),
    present("AAAA", dns.resolve6(zone)),
    present("CNAME", dns.resolveCname(zone)),
    present("MX", dns.resolveMx(zone)),
    present("TXT", dns.resolveTxt(zone)),
    present("CAA", dns.resolveCaa(zone)),
  ]);
  return {
    zone,
    nameservers,
    cloudflareDelegated: isCloudflareDelegation(nameservers),
    existingRecordTypes: records.filter((record): record is string => record !== null),
  };
}
