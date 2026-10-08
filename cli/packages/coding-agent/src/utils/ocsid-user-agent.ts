export function getOcsidUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `ocsid/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
