import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import type { SessionUser } from "../../shared/types.js";

// auth.ts staticky importuje db/index.js, který vyhodí výjimku bez DATABASE_URL.
// Pool se vytváří líně (bez DATABASE_URL), takže stačí jakákoli hodnota -
// žádné připojení se v testech neotevírá (testované funkce DB nevolají).
process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const { requireWriteAccess, requireRole, requireAuth } = await import(
  "./auth.js"
);

// Minimální dvojníci Express req/res, které zachytí status a JSON tělo.
function mockReqRes(user?: SessionUser) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const req = { currentUser: user } as unknown as Request;
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  return { req, res: res as unknown as Response & typeof res, next, calledNext: () => nextCalled };
}

const adminUser: SessionUser = {
  id: "a1",
  name: "Admin",
  email: "a@x.cz",
  role: "admin",
};
const normalUser: SessionUser = {
  id: "u1",
  name: "User",
  email: "u@x.cz",
  role: "user",
};
const readOnlyUser: SessionUser = {
  id: "r1",
  name: "Read",
  email: "r@x.cz",
  role: "read_only",
};

test("requireWriteAccess blocks read_only with 403", () => {
  const { req, res, next, calledNext } = mockReqRes(readOnlyUser);
  requireWriteAccess(req, res, next);
  assert.equal(calledNext(), false);
  assert.equal(res.statusCode, 403);
});

test("requireWriteAccess allows user and admin", () => {
  for (const u of [normalUser, adminUser]) {
    const { req, res, next, calledNext } = mockReqRes(u);
    requireWriteAccess(req, res, next);
    assert.equal(calledNext(), true);
    assert.equal(res.statusCode, 0);
  }
});

test("requireWriteAccess rejects unauthenticated with 401", () => {
  const { req, res, next, calledNext } = mockReqRes(undefined);
  requireWriteAccess(req, res, next);
  assert.equal(calledNext(), false);
  assert.equal(res.statusCode, 401);
});

test("requireRole('admin') blocks non-admins (delete is admin-only)", () => {
  for (const u of [normalUser, readOnlyUser]) {
    const { req, res, next, calledNext } = mockReqRes(u);
    requireRole("admin")(req, res, next);
    assert.equal(calledNext(), false);
    assert.equal(res.statusCode, 403);
  }
});

test("requireRole('admin') allows admin", () => {
  const { req, res, next, calledNext } = mockReqRes(adminUser);
  requireRole("admin")(req, res, next);
  assert.equal(calledNext(), true);
});

test("requireAuth requires a logged-in user", () => {
  const anon = mockReqRes(undefined);
  requireAuth(anon.req, anon.res, anon.next);
  assert.equal(anon.calledNext(), false);
  assert.equal(anon.res.statusCode, 401);

  const authed = mockReqRes(normalUser);
  requireAuth(authed.req, authed.res, authed.next);
  assert.equal(authed.calledNext(), true);
});
