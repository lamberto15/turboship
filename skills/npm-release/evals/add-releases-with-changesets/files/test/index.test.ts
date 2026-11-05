import assert from "node:assert/strict";
import { test } from "node:test";
import { camelCase, kebabCase, snakeCase } from "../src/index.ts";

test("converts between cases", () => {
	assert.equal(camelCase("hello_big world"), "helloBigWorld");
	assert.equal(snakeCase("helloBigWorld"), "hello_big_world");
	assert.equal(kebabCase("Hello Big-World"), "hello-big-world");
});
