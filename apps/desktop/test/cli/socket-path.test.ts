import { describe, expect, test } from "bun:test";
import { candidateSocketPaths } from "../../src/cli/socket-path";

const home = "/h/me";
const support = `${home}/Library/Application Support/dev.jslab.app`;

describe("candidateSocketPaths", () => {
  test("defaults to every channel, stable first", () => {
    expect(candidateSocketPaths({}, home)).toEqual([
      `${support}/stable/jslab.sock`,
      `${support}/canary/jslab.sock`,
      `${support}/dev/jslab.sock`,
    ]);
  });

  test("JSLAB_SOCKET wins outright", () => {
    expect(candidateSocketPaths({ JSLAB_SOCKET: "/tmp/x/jslab.sock" }, home)).toEqual(["/tmp/x/jslab.sock"]);
  });

  test("JSLAB_USER_DATA points at one data folder, as a launched app's own paths do", () => {
    expect(candidateSocketPaths({ JSLAB_USER_DATA: "/tmp/u1" }, home)).toEqual(["/tmp/u1/jslab.sock"]);
  });

  test("JSLAB_CHANNEL moves one channel to the front without hiding the others", () => {
    expect(candidateSocketPaths({ JSLAB_CHANNEL: "canary" }, home)).toEqual([
      `${support}/canary/jslab.sock`,
      `${support}/stable/jslab.sock`,
      `${support}/dev/jslab.sock`,
    ]);
  });

  test("an unknown channel is ignored rather than producing a path that can't exist", () => {
    expect(candidateSocketPaths({ JSLAB_CHANNEL: "../escape" }, home)).toEqual(candidateSocketPaths({}, home));
  });

  test("a path macOS can't bind is dropped, not offered", () => {
    const deep = `/tmp/${"d".repeat(120)}`;
    expect(candidateSocketPaths({ JSLAB_USER_DATA: deep }, home)).toEqual([]);
  });
});
