import { StudentScores } from "../components/StudentScores";

/**
 * /scores 路由页：从 App.tsx 1788-1797 行抽离。
 */
export function ScoresRoutePage() {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6 lg:px-8">
      <StudentScores />
    </div>
  );
}
