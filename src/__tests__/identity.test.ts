/**
 * Tests for identity name resolution from IDENTITY.md content.
 */

import { describe, expect, test } from "bun:test";

import { parseIdentityName } from "../identity.ts";

describe("parseIdentityName", () => {
  test("extracts the first H1 heading", () => {
    const content = "# ApolloBot\n\nSome description.\n";
    expect(parseIdentityName(content)).toBe("ApolloBot");
  });

  test("extracts a name: field", () => {
    const content = "_ comment\n\n# IDENTITY.md\n\n- **Name:** not this\nname: ApolloBot\n";
    expect(parseIdentityName(content)).toBe("ApolloBot");
  });

  test("prefers name: field over H1", () => {
    const content = "# Some Heading\nname: RealName\n";
    expect(parseIdentityName(content)).toBe("RealName");
  });

  test("returns null for placeholder H1", () => {
    const content = "# IDENTITY.md\n\n- **Name:** _(not yet chosen)_\n";
    expect(parseIdentityName(content)).toBeNull();
  });

  test("returns null for placeholder name field", () => {
    const content = "name: _(not yet chosen)_\n";
    expect(parseIdentityName(content)).toBeNull();
  });

  test("returns null when no name found", () => {
    const content = "Just some text without a heading or name field.\n";
    expect(parseIdentityName(content)).toBeNull();
  });

  test("returns null for empty content", () => {
    expect(parseIdentityName("")).toBeNull();
  });

  test("skips H2 and lower headings", () => {
    const content = "## Subheading\n\nMore text.\n";
    expect(parseIdentityName(content)).toBeNull();
  });

  test("handles whitespace around name", () => {
    const content = "#   Spaced Name   \n";
    expect(parseIdentityName(content)).toBe("Spaced Name");
  });
});
