import { useState } from "react";
import { GraduationCap, UserCog } from "lucide-react";
import { TeacherManagement } from "./TeacherManagement";
import { ClassManagement } from "./ClassManagement";

type AccountTab = "teachers" | "classes";

export function AccountManagement() {
  const [tab, setTab] = useState<AccountTab>("teachers");

  return (
    <div className="account-management">
      <div className="account-tabs">
        <button
          type="button"
          className={tab === "teachers" ? "active" : ""}
          onClick={() => setTab("teachers")}
        >
          <UserCog size={15} /> 教师管理
        </button>
        <button
          type="button"
          className={tab === "classes" ? "active" : ""}
          onClick={() => setTab("classes")}
        >
          <GraduationCap size={15} /> 学生管理
        </button>
      </div>
      {tab === "teachers" ? <TeacherManagement /> : <ClassManagement />}
    </div>
  );
}
