import { describe, expect, it } from "vitest";
import { classifyJavbusPage } from "./javbusPage";

describe("classifyJavbusPage", () => {
  it.each([
    ["film content", '<a class="movie-box" href="/ABP-123"></a>', "content"],
    ["年龄验证", '<title>Age Verification JavBus - JavBus</title><div id="ageVerify"></div>', "verification_required"],
    ["region driving quiz", "<h1>Region verification</h1><p>駕駛考試題</p>", "verification_required"],
    ["login wall", '<form><h2>Login</h2><input name="username" /><input type="password" /></form>', "login_wall"],
    [
      "newsletter email field with a login link is not a login wall",
      '<a href="/login">登录</a><form><input type="email" name="email" /></form>',
      "unknown",
    ],
    ["unknown page", "<main>temporarily unavailable</main>", "unknown"],
  ] as const)("classifies %s", (_name, html, expected) => {
    expect(classifyJavbusPage(html)).toBe(expected);
  });
});
