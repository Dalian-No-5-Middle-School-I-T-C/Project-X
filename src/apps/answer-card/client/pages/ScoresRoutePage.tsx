import { StudentScores } from "../components/StudentScores";

/**
 * /scores 路由页：从 App.tsx 1788-1797 行抽离。
 */
export function ScoresRoutePage() {
  return (
    <div className="main-grid scores-grid">
      <section className="preview-panel" style={{ gridColumn: "1 / -1" }}>
        <StudentScores />
      </section>
    </div>
  );
}
