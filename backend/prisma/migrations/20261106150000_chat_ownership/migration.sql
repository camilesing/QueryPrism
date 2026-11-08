-- Per-user chat ownership (Chat.create_by / ChatRecord.create_by).
-- Legacy rows stay NULL and remain visible workspace-wide; new rows always
-- carry the creator uid so list/rename/delete/record reads can scope by user.
ALTER TABLE "Chat" ADD COLUMN "createBy" INTEGER;
ALTER TABLE "ChatRecord" ADD COLUMN "createBy" INTEGER;

CREATE INDEX "Chat_oid_createBy_idx" ON "Chat"("oid", "createBy");
CREATE INDEX "ChatRecord_chatId_createBy_idx" ON "ChatRecord"("chatId", "createBy");
