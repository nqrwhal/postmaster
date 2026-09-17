import Foundation

@main
struct DateFormattingTests {
    static func main() {
        testCalendarDatesAndLegacyCachedEstimates()
        testSystemTimestampsRespectDSTAndExplicitDeviceTimezone()
        print("Mac date formatting: calendar, legacy cache, invalid dates, and DST checks passed")
    }
    static func testCalendarDatesAndLegacyCachedEstimates() {
        let locale = Locale(identifier: "en_US")
        for value in ["2026-09-18", "2026-09-18T00:00:00Z", "2026-09-18T23:00:00-07:00"] {
            precondition(PostmasterDates.deliveryDate(value, locale: locale) == "Sep 18")
        }
        for value in ["", "invalid", "2026-02-30", "2026-13-01"] {
            precondition(PostmasterDates.deliveryDate(value, locale: locale) == nil)
        }
    }

    static func testSystemTimestampsRespectDSTAndExplicitDeviceTimezone() {
        let parser = ISO8601DateFormatter()
        let locale = Locale(identifier: "en_US")
        let pacific = TimeZone(identifier: "America/Los_Angeles")!
        let cases = [
            ("2026-03-08T09:30:00Z", "1:30", "PST"),
            ("2026-03-08T10:30:00Z", "3:30", "PDT"),
            ("2026-11-01T08:30:00Z", "1:30", "PDT"),
            ("2026-11-01T09:30:00Z", "1:30", "PST")
        ]
        for (value, clock, zone) in cases {
            let formatted = PostmasterDates.timestamp(parser.date(from: value)!, locale: locale, timeZone: pacific)
            precondition(formatted.contains(clock), formatted)
            precondition(formatted.contains(zone), formatted)
        }
    }
}
