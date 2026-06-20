import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeDocumentWrite,
  type DocumentAccessSubject,
  type DocumentAccessTarget,
} from "./document-access.js";

const admin: DocumentAccessSubject = { id: "admin-1", role: "admin" };
const user: DocumentAccessSubject = { id: "user-1", role: "user" };
const otherUser: DocumentAccessSubject = { id: "user-2", role: "user" };
const readOnly: DocumentAccessSubject = { id: "ro-1", role: "read_only" };

const ownAllUsersDoc: DocumentAccessTarget = {
  uploadedByUserId: "user-1",
  visibility: "all_users",
};
const othersAllUsersDoc: DocumentAccessTarget = {
  uploadedByUserId: "user-2",
  visibility: "all_users",
};
const adminOnlyDoc: DocumentAccessTarget = {
  uploadedByUserId: "user-1",
  visibility: "admin_only",
};

test("admin may write any document (own, others', admin_only)", () => {
  assert.deepEqual(authorizeDocumentWrite(ownAllUsersDoc, admin), { ok: true });
  assert.deepEqual(authorizeDocumentWrite(othersAllUsersDoc, admin), {
    ok: true,
  });
  assert.deepEqual(authorizeDocumentWrite(adminOnlyDoc, admin), { ok: true });
});

test("user may write own all_users document", () => {
  assert.deepEqual(authorizeDocumentWrite(ownAllUsersDoc, user), { ok: true });
});

test("user may NOT write another user's document (403)", () => {
  const decision = authorizeDocumentWrite(othersAllUsersDoc, user);
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.status, 403);
});

test("user may NOT write admin_only document even if they uploaded it (403)", () => {
  const decision = authorizeDocumentWrite(adminOnlyDoc, user);
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.status, 403);
});

test("admin_only takes precedence over ownership for non-admins", () => {
  // Vlastník i ne-vlastník dostanou 403 u admin_only dokumentu.
  assert.equal(authorizeDocumentWrite(adminOnlyDoc, user).ok, false);
  assert.equal(authorizeDocumentWrite(adminOnlyDoc, otherUser).ok, false);
  assert.equal(authorizeDocumentWrite(adminOnlyDoc, readOnly).ok, false);
});

test("read_only is treated as a non-owner non-admin for document-level checks", () => {
  // read_only je primárně blokován middlewarem requireWriteAccess (viz auth.test.ts),
  // ale i na úrovni dokumentu nesmí měnit cizí ani admin_only dokumenty.
  assert.equal(authorizeDocumentWrite(othersAllUsersDoc, readOnly).ok, false);
  assert.equal(authorizeDocumentWrite(adminOnlyDoc, readOnly).ok, false);
});
