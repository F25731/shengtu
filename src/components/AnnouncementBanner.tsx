interface AnnouncementBannerProps {
  text: string
}

export default function AnnouncementBanner({ text }: AnnouncementBannerProps) {
  const content = text.trim()
  if (!content) return null

  return (
    <section className="mb-6 rounded-2xl border border-amber-400/30 bg-amber-400/[0.10] px-4 py-3.5 shadow-[0_18px_54px_rgba(245,158,11,0.08)] sm:mb-8 sm:px-5">
      <div className="flex items-start gap-3 sm:items-center">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-400 text-lg font-black leading-none text-white shadow-[0_0_22px_rgba(245,158,11,0.38)] sm:mt-0">
          !
        </div>
        <p className="text-[13px] font-semibold leading-6 text-amber-300 sm:text-sm">
          {content}
        </p>
      </div>
    </section>
  )
}
