import { useState } from "react";
import { GraduationCap, UserCog } from "lucide-react";
import { TeacherManagement } from "./TeacherManagement";
import { ClassManagement } from "./ClassManagement";

type AccountTab = "teachers" | "classes";

export function AccountManagement() {
  const [tab, setTab] = useState<AccountTab>("teachers");

  return (
    <div className="account-management h-full w-full p-6">
      <div className="mb-6 flex gap-4 border-b border-border-subtle">
        <button
          type="button"
          className={`flex h-10 items-center gap-2 border-0 border-b-2 bg-transparent px-3 text-sm font-medium ${tab === "teachers" ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}
          onClick={() => setTab("teachers")}
        >
          <UserCog size={15} /> 教师管理
        </button>
        <button
          type="button"
          className={`flex h-10 items-center gap-2 border-0 border-b-2 bg-transparent px-3 text-sm font-medium ${tab === "classes" ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}
          onClick={() => setTab("classes")}
        >
          <GraduationCap size={15} /> 学生管理
        </button>
      </div>
      {tab === "teachers" ? <TeacherManagement /> : <ClassManagement />}
    </div>
  );
}
