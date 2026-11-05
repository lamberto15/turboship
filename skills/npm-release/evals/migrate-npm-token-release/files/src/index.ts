export function words(input: string): string[] {
	return input
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase());
}

export const camelCase = (s: string): string =>
	words(s)
		.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
		.join("");

export const snakeCase = (s: string): string => words(s).join("_");

export const kebabCase = (s: string): string => words(s).join("-");
