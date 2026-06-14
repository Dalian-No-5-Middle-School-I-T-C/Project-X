import { useState } from "react";
import { GraduationCap, Users } from "lucide-react";
import { UserManagement } from "./UserManagement";
import { ClassManagement } from "./ClassManagement";

type AccountTab = "users" | "classes";

export function AccountManagement() {
  const [tab, setTab] = useState<AccountTab>("users");

  return (
    <div className="account-management">
      <div className="account-tabs">
        <button
          type="button"
          className={tab === "users" ? "active" : ""}
          onClick={() => setTab("users")}
        >
          <Users size={15} /> 用户管理
        </button>
        <button
          type="button"
          className={tab === "classes" ? "active" : ""}
          onClick={() => setTab("classes")}
        >
          <GraduationCap size={15} /> 班级管理
        </button>
      </div>
      {tab === "users" ? <UserManagement /> : <ClassManagement />}
    </div>
  );
}
