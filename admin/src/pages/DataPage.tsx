import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Table, useTableSelection, useTableSelectionState } from "@astryxdesign/core/Table";
import { api, formatTime } from "../api";

interface RecordRow extends Record<string, unknown> {
  id: string;
  source: string;
  country_name: string;
  matched_target: string;
  matched_term: string;
  author_name: string;
  author_handle: string;
  original_text: string;
  translation_zh: string | null;
  url: string;
  published_at: string | null;
  collected_at: string;
  relevance_score: number | null;
  relevance_error: string | null;
  exclude_reason: string | null;
  is_spam: number;
}

export function DataPage() {
  const [view, setView] = useState("all");
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [scoreMode, setScoreMode] = useState<"" | "selected" | "unscored">("");
  const [scoring, setScoring] = useState(false);
  const { selectionConfig } = useTableSelectionState({
    data: records,
    idKey: "id",
    selectedKeys,
    setSelectedKeys,
  });
  const selection = useTableSelection(selectionConfig);

  function load(nextView = view) {
    return api<{ records: RecordRow[]; total: number }>(`/api/records?view=${nextView}&limit=50`)
      .then((payload) => {
        setRecords(payload.records);
        setTotal(payload.total);
      });
  }

  useEffect(() => {
    load(view).catch((reason: Error) => setError(reason.message));
    // view 变化时重新拉取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  async function runScore() {
    const mode = scoreMode;
    if (!mode) return;
    setScoring(true);
    setError("");
    let scored = 0;
    let failed = 0;
    try {
      if (mode === "selected") {
        const ids = [...selectedKeys];
        for (let index = 0; index < ids.length; index += 20) {
          const result = await api<{ scored: number; failed: number }>("/api/records/rescore", {
            method: "POST",
            body: JSON.stringify({ mode: "selected", ids: ids.slice(index, index + 20) }),
          });
          scored += result.scored;
          failed += result.failed;
        }
      } else {
        for (let round = 0; round < 15; round += 1) {
          const result = await api<{ scored: number; failed: number; attempted: number; remaining: number }>(
            "/api/records/rescore",
            { method: "POST", body: JSON.stringify({ mode: "unscored" }) },
          );
          scored += result.scored;
          failed += result.failed;
          if (result.attempted === 0 || result.remaining === 0) break;
        }
      }
      setScoreMode("");
      setSelectedKeys(new Set());
      setNotice(failed > 0 ? `已评分 ${scored} 条，${failed} 条失败` : `已评分 ${scored} 条`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "评分失败");
    } finally {
      setScoring(false);
    }
  }

  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={1}>数据</Heading>
        <Text type="body" color="secondary">
          {`今日和昨日按发布时间的计划窗口筛选，只含可进入日报的条目。全部视图含时间不明和低相关度记录，供核对。当前筛选共 ${total} 条。表头复选框只选中这一页。删除后记录从列表和 Excel 消失，同一条内容不会再被采集进来。`}
        </Text>
      </VStack>
      {error ? <Banner status="error" title="操作失败" description={error} /> : null}
      {notice ? <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice("")} /> : null}
      <HStack gap={2}>
        <Selector
          label="视图"
          value={view}
          onChange={(value) => {
            setSelectedKeys(new Set());
            setView(value);
          }}
          options={[
            { value: "all", label: "全部" },
            { value: "today", label: "今日" },
            { value: "yesterday", label: "昨日" },
          ]}
        />
        <Button
          label="手动运行"
          variant="primary"
          onClick={() => {
            setError("");
            api<{ runId: string }>("/api/runs", { method: "POST" })
              .then((result) => setNotice(`已开始运行 ${result.runId}`))
              .catch((reason: Error) => setError(reason.message));
          }}
        />
        <Button
          label="重新生成 Excel"
          variant="secondary"
          onClick={() => {
            api("/api/export/excel", { method: "POST" })
              .then(() => setNotice("已覆盖 skyeyes.xlsx"))
              .catch((reason: Error) => setError(reason.message));
          }}
        />
        <Button
          label={selectedKeys.size > 0 ? `为所选评分 ${selectedKeys.size} 条` : "为所选评分"}
          variant="secondary"
          isDisabled={selectedKeys.size === 0 || scoring || deleting}
          onClick={() => setScoreMode("selected")}
        />
        <Button
          label="为未评分记录打分"
          variant="secondary"
          isDisabled={scoring || deleting}
          onClick={() => setScoreMode("unscored")}
        />
        <Button
          label={selectedKeys.size > 0 ? `删除所选 ${selectedKeys.size} 条` : "删除所选"}
          variant="destructive"
          isDisabled={selectedKeys.size === 0 || deleting}
          onClick={() => setPendingIds([...selectedKeys])}
        />
        <Button
          label="下载 Excel"
          variant="secondary"
          onClick={() => {
            fetch("/api/export/excel")
              .then(async (response) => {
                if (!response.ok) {
                  const payload = await response.json() as { error?: string };
                  throw new Error(payload.error || "下载失败");
                }
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "skyeyes.xlsx";
                anchor.click();
                URL.revokeObjectURL(url);
              })
              .catch((reason: Error) => setError(reason.message));
          }}
        />
      </HStack>
      <Table
        density="compact"
        idKey="id"
        textOverflow="truncate"
        data={records}
        plugins={{ selection }}
        columns={[
          { key: "published_at", header: "发布", renderCell: (row) => formatTime(row.published_at) },
          { key: "collected_at", header: "采集", renderCell: (row) => formatTime(row.collected_at) },
          { key: "country_name", header: "国家" },
          { key: "source", header: "来源" },
          { key: "matched_target", header: "目标" },
          { key: "matched_term", header: "检索词", renderCell: (row) => row.matched_term || "—" },
          { key: "author_name", header: "作者" },
          {
            key: "relevance_score",
            header: "相关度",
            renderCell: (row) => row.relevance_score ?? row.relevance_error ?? "—",
          },
          { key: "exclude_reason", header: "排除", renderCell: (row) => row.exclude_reason || (row.is_spam ? "spam" : "—") },
          { key: "original_text", header: "原文" },
          { key: "translation_zh", header: "中文", renderCell: (row) => row.translation_zh || "—" },
          {
            key: "actions",
            header: "审核",
            renderCell: (row) => (
              <HStack gap={1}>
                <Button
                  label="标为垃圾"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    api(`/api/records/${row.id}/spam`, { method: "POST", body: JSON.stringify({ blockAuthor: false }) })
                      .then(() => load())
                      .catch((reason: Error) => setError(reason.message));
                  }}
                />
                <Button
                  label="删除"
                  size="sm"
                  variant="destructive"
                  onClick={() => setPendingIds([row.id])}
                />
                <Button
                  label="屏蔽作者"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    api(`/api/records/${row.id}/spam`, { method: "POST", body: JSON.stringify({ blockAuthor: true }) })
                      .then(() => {
                        setNotice("已标为垃圾，并加入屏蔽名单");
                        return load();
                      })
                      .catch((reason: Error) => setError(reason.message));
                  }}
                />
              </HStack>
            ),
          },
          {
            key: "url",
            header: "链接",
            renderCell: (row) => row.url,
          },
        ]}
      />
      <Dialog
        isOpen={scoreMode !== ""}
        purpose="form"
        width={440}
        onOpenChange={(open) => {
          if (!open && !scoring) setScoreMode("");
        }}
      >
        <VStack gap={3}>
          <DialogHeader
            title={scoreMode === "selected" ? `为所选 ${selectedKeys.size} 条评分` : "为未评分记录打分"}
            onOpenChange={(open) => {
              if (!open && !scoring) setScoreMode("");
            }}
          />
          <Text type="body">
            {scoreMode === "selected"
              ? "会重新调用模型给这些记录打分，并覆盖原来的分数或失败原因。每次 20 条，多出来的会接着评。"
              : "只给还没有分数、也没有失败原因的记录打分，每次 20 条。已经失败的记录请勾选后再评。"}
          </Text>
          <HStack gap={2}>
            <Button
              label="开始评分"
              variant="primary"
              isLoading={scoring}
              onClick={() => {
                void runScore();
              }}
            />
            <Button
              label="取消"
              variant="secondary"
              isDisabled={scoring}
              onClick={() => setScoreMode("")}
            />
          </HStack>
        </VStack>
      </Dialog>
      <Dialog
        isOpen={pendingIds.length > 0}
        purpose="form"
        width={440}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingIds([]);
        }}
      >
        <VStack gap={3}>
          <DialogHeader
            title={pendingIds.length > 1 ? `删除 ${pendingIds.length} 条记录` : "删除这条记录"}
            onOpenChange={(open) => {
              if (!open && !deleting) setPendingIds([]);
            }}
          />
          <Text type="body">
            删除后它会从数据页和 Excel 里消失。同一链接、同一外部编号，以及标题几乎相同的内容都不会再入库。这一步不能在页面上撤销。
          </Text>
          <HStack gap={2}>
            <Button
              label="删除"
              variant="destructive"
              isLoading={deleting}
              onClick={() => {
                const ids = pendingIds;
                setDeleting(true);
                setError("");
                const request = ids.length === 1
                  ? api<{ deleted: number; excel: boolean; excelError: string | null }>(`/api/records/${ids[0]}`, { method: "DELETE" })
                  : api<{ deleted: number; excel: boolean; excelError: string | null }>("/api/records/delete", {
                    method: "POST",
                    body: JSON.stringify({ ids }),
                  });
                request.then(async (result) => {
                  setPendingIds([]);
                  setSelectedKeys(new Set());
                  if (result.excel) setNotice(`已删除 ${result.deleted} 条，并重新生成 Excel`);
                  else setError(result.excelError || "记录已删除，但 Excel 没有更新。请点重新生成。");
                  await load();
                }).catch((reason: Error) => setError(reason.message))
                  .finally(() => setDeleting(false));
              }}
            />
            <Button
              label="取消"
              variant="secondary"
              isDisabled={deleting}
              onClick={() => setPendingIds([])}
            />
          </HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
}
