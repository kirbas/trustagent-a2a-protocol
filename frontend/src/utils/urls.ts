// Determine proxy URL dynamically based on current browser location
export const getProxyUrl = (defaultPort: number, envVar?: string) => {
  if (envVar) return envVar;
  if (typeof window === "undefined") return `http://localhost:${defaultPort}`;
  const host = window.location.hostname;
  return `http://${host}:${defaultPort}`;
};
