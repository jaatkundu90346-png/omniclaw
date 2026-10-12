export async function checkGatewayAuthOverview() {
  const response = await fetch("/api/auth/overview");
  if (!response.ok) {
    throw new Error(`Gateway auth check failed with status ${response.status}`);
  }
  return response.json();
}

export function formatGatewayConnectState(overview = {}) {
  const gateway = overview.gateway || {};
  if (!gateway.configured) {
    return "Gateway token not configured. Rotate token in Trust panel first.";
  }
  if (gateway.status === "revoked") {
    return "Gateway token is revoked. Rotate a new token before connecting.";
  }
  if (gateway.status === "expired") {
    return "Gateway token is expired. Rotate a new token before connecting.";
  }
  return "Gateway token is active. You can connect now.";
}
