import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Table } from "@astryxdesign/core/Table";
import { api, formatTime, timeHeader } from "../api";

interface EmailLogRow extends Record<string, unknown> {
  id: string;
  run_id: string | null;
  kind: string;
  recipients: string;
  subject: string;
  status: string;
  error: string | null;
  message_id: string | null;
  attachment_mode: string;
  attachment_bytes: number;
  created_at: string;
}

interface EmailLogPayload {
  entries: EmailLogRow[];
  total: number;
  page: number;
  pageSize: number;
  timeZone: string;
  utcOffset: string;
}

const KIND: Record<string, string> = {
  daily: "日报",
  test: "测试",
};

const STATUS: Record<string, string> = {
  sent: "已发送",
  failed: "失败",
};

const ATTACHMENT: Record<string, string> = {
  attached: "附件",
  link: "下载链接",
  none: "无",
};

const PAGE_SIZES = ["20", "50", "100"];

function formatBytes(size: number): string {
  if (!size) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function EmailLogPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("20");
  const [entries, setEntries] = useState<EmailLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [timeZone, setTimeZone] = useState("");
  const [utcOffset, setUtcOffset] = useState("");
  const [error, setError] = useState("");

  const pageCount = Math.max(1, Math.ceil(total / Number(pageSize)));

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", pageSize);
    api<EmailLogPayload>(`/api/email-log?${params.toString()}`)
      .then((payload) => {
        setEntries(payload.entries);
        setTotal(payload.total);
        setTimeZone(payload.timeZone);
        setUtcOffset(payload.utcOffset);
        setError("");
      })
      .catch((reason: Error) => setError(reason.message));
  }, [page, pageSize]);

  if (error) return <Banner status="error" title="无法读取发信记录" description={error} />;

  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={1}>发信记录</Heading>
        <Text type="body" color="secondary">
          {`日报和测试信的发送结果。时间按 ${timeZone || "配置时区"} 显示。`}
        </Text>
      </VStack>
      <HStack gap={2}>
        <Selector
          label="每页"
          value={pageSize}
          onChange={(value) => {
            setPage(1);
            setPageSize(value);
          }}
          options={PAGE_SIZES.map((size) => ({ value: size, label: `${size} 条` }))}
        />
        <Button label="上一页" variant="secondary" isDisabled={page <= 1} onClick={() => setPage(page - 1)} />
        <Button label="下一页" variant="secondary" isDisabled={page >= pageCount} onClick={() => setPage(page + 1)} />
        <Text type="body" color="secondary">{`第 ${page} / ${pageCount} 页，共 ${total} 条`}</Text>
      </HStack>
      <Table
        density="compact"
        idKey="id"
        textOverflow="truncate"
        data={entries}
        columns={[
          { key: "created_at", header: timeHeader("时间", timeZone, utcOffset), renderCell: (row) => formatTime(row.created_at, timeZone) },
          { key: "kind", header: "类型", renderCell: (row) => KIND[row.kind] ?? row.kind },
          { key: "recipients", header: "收件人", renderCell: (row) => row.recipients || "—" },
          { key: "subject", header: "主题" },
          { key: "status", header: "状态", renderCell: (row) => STATUS[row.status] ?? row.status },
          { key: "error", header: "错误", renderCell: (row) => row.error || "—" },
          { key: "message_id", header: "邮件编号", renderCell: (row) => row.message_id || "—" },
          { key: "attachment_mode", header: "附件", renderCell: (row) => ATTACHMENT[row.attachment_mode] ?? row.attachment_mode },
          { key: "attachment_bytes", header: "大小", renderCell: (row) => formatBytes(row.attachment_bytes) },
        ]}
      />
    </VStack>
  );
}
