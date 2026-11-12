export default function SkeletonLoader() {
  return (
    <div className="w-full max-w-md mx-auto p-6 space-y-4 animate-pulse">
      {/* Status banner */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-center">
        <p className="text-xs text-amber-600 font-medium">
          ⏳ Waking up free-tier server (Cold start can take ~20–30s)...
        </p>
      </div>

      {/* Simulated header */}
      <div className="h-7 bg-gray-200 dark:bg-gray-800 rounded-md w-3/4"></div>

      {/* Simulated input / upload box */}
      <div className="h-32 bg-gray-200 dark:bg-gray-800 rounded-xl w-full"></div>

      {/* Simulated buttons */}
      <div className="flex gap-3">
        <div className="h-10 bg-gray-200 dark:bg-gray-800 rounded-lg w-1/2"></div>
        <div className="h-10 bg-gray-200 dark:bg-gray-800 rounded-lg w-1/2"></div>
      </div>
    </div>
  );
}