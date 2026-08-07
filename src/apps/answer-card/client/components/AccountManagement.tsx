import { GraduationCap, UserCog } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/v2/tabs";
import { TeacherManagement } from "./TeacherManagement";
import { ClassManagement } from "./ClassManagement";

export function AccountManagement() {
  return (
    <Tabs defaultValue="teachers" className="flex flex-col gap-4">
      <TabsList>
        <TabsTrigger value="teachers">
          <UserCog size={15} /> 教师管理
        </TabsTrigger>
        <TabsTrigger value="classes">
          <GraduationCap size={15} /> 学生管理
        </TabsTrigger>
      </TabsList>
      <TabsContent value="teachers">
        <TeacherManagement />
      </TabsContent>
      <TabsContent value="classes">
        <ClassManagement />
      </TabsContent>
    </Tabs>
  );
}
