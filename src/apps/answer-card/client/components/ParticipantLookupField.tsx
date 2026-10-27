import { useEffect, useState } from "react";
import { Input } from "./ui/v2";

export type ParticipantLookupStudent = {
  id: number;
  name: string;
  student_number: string | null;
};

/** 应考名单联想：按姓名或考号搜索，选中后回填学号。 */
export function ParticipantLookupField({
  examId,
  request,
  onPick,
  disabled,
  className,
}: {
  examId: number | null;
  request: (url: string, init?: RequestInit) => Promise<Response>;
  onPick: (studentNumber: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [lookup, setLookup] = useState("");
  const [roster, setRoster] = useState<ParticipantLookupStudent[]>([]);

  useEffect(() => {
    const keyword = lookup.trim();
    if (examId === null || keyword.length < 2) {
      setRoster([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await request(`/api/exams/${examId}/participant-search?q=${encodeURIComponent(keyword)}`);
          const data = await response.json();
          if (!alive) return;
          if (response.ok) setRoster((data.students ?? []) as ParticipantLookupStudent[]);
        } catch {
          /* 名单查不到不影响手输考号 */
        }
      })();
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [lookup, examId, request]);

  if (examId === null) return null;

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
