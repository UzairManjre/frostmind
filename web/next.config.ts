import os from "node:os";
import type { NextConfig } from "next";

// The dev server blocks its own scripts (/_next/*) for any origin other than localhost, so the
// admin panel opened from a phone/another laptop as http://<LAN-IP>:3000 would render but never
// hydrate (buttons dead, no API calls). Allow this machine's CURRENT network addresses -- read at
// startup, so nothing is tied to one IP and it works on whichever laptop runs it.
const lanAddresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
  .map((i) => i.address);

const nextConfig: NextConfig = {
  allowedDevOrigins: [...lanAddresses, os.hostname(), `${os.hostname()}.local`],
};

export default nextConfig;
