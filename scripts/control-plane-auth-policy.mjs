export function shouldAttachControlPlaneAuthorization(url, baseUrl) {
  const controlPlane = new URL(baseUrl);
  return (
    url.origin === controlPlane.origin &&
    url.pathname.startsWith('/api/v1/')
  );
}
