import { useEffect, useState } from "react";
import { Input } from "./ui/v2";

export type ParticipantLookupStudent = {
  id: number;
  name: string;
  student_number: string | null;
};

/** 花名册联想作用域：教师浏览器走考试 API；远端上传走扫描端会话 API（仅 X-Api-Key）。 */
export type ParticipantSearchScope =
  | { type: "exam"; examId: number }
  | { type: "uploadSession"; sessionId: string };

function participantSearchUrl(scope: ParticipantSearchScope, keyword: string): string {
  const q = encodeURIComponent(keyword);
  if (scope.type === "exam") return `/api/exams/${scope.examId}/participant-search?q=${q}`;
  return `/api/scanner/upload/sessions/${encodeURIComponent(scope.sessionId)}/participant-search?q=${q}`;
}

/** 应考名单联想：按姓名或考号搜索，选中后回填学号。 */
export function ParticipantLookupField({
  scope,
  request,
  onPick,
  disabled,
  className,
}: {
  scope: ParticipantSearchScope | null;
  request: (url: string, init?: RequestInit) => Promise<Response>;
  onPick: (studentNumber: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [lookup, setLookup] = useState("");
  const [roster, setRoster] = useState<ParticipantLookupStudent[]>([]);
  const scopeKey = scope
    ? (scope.type === "exam" ? `exam:${scope.examId}` : `upload:${scope.sessionId}`)
    : null;

  useEffect(() => {
    const keyword = lookup.trim();
    if (!scope || !scopeKey || keyword.length < 2) {
      setRoster([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        setRoster([]);
        try {
          const response = await request(participantSearchUrl(scope, keyword));
          const data = await response.json();
          if (!alive) return;
          if (response.ok) setRoster((data.students ?? []) as ParticipantLookupStudent[]);
          else setRoster([]);
        } catch {
          if (alive) setRoster([]);
        }
      })();
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [lookup, scope, scopeKey, request]);

  if (!scope) return null;

  return (
    <div className={className ?? "flex min-w-0 flex-col gap-1.5"}>
      <Input
        type="search"
        value={lookup}
        onChange={e => setLookup(e.target.value)}
        placeholder="输入姓名或考号搜索应考学生"
        aria-label="搜索学生"
        disabled={disabled}
        className="text-sm"
      />
      {roster.length > 0 && (
        <ul className="m-0 flex max-h-32 flex-col gap-1 overflow-auto rounded-md border border-border-subtle bg-card p-1.5 text-sm">
          {roster.map(student => (
            <li key={student.id}>
              <button
                type="button"
                className="w-full truncate rounded-sm px-1.5 py-1 text-left hover:bg-secondary disabled:opacity-50"
                disabled={disabled || !student.student_number}
                onClick={() => {
                  if (!student.student_number) return;
                  onPick(student.student_number);
                  setLookup("");
                  setRoster([]);
                }}
              >
                <span className="tabular-nums">{student.student_number ?? "无考号"}</span>
                <span className="ml-2 text-muted-foreground">{student.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
