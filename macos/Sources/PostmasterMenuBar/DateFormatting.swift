import Foundation

enum PostmasterDates {
    // Includes legacy cached ISO estimates: the carrier's calendar day must
    // never be interpreted as a midnight-UTC instant and shifted backwards.
    static func deliveryDate(_ value: String, locale: Locale = .autoupdatingCurrent) -> String? {
        guard value.count == 10 || value.dropFirst(10).first == "T" else { return nil }
        let day = String(value.prefix(10))
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.calendar = Calendar(identifier: .gregorian)
        parser.timeZone = TimeZone(secondsFromGMT: 0)
        parser.dateFormat = "yyyy-MM-dd"
        parser.isLenient = false
        guard let date = parser.date(from: day), parser.string(from: date) == day else { return nil }
        let display = DateFormatter()
        display.locale = locale
        display.timeZone = TimeZone(secondsFromGMT: 0)
        display.setLocalizedDateFormatFromTemplate("MMMd")
        return display.string(from: date)
    }

    static func timestamp(_ date: Date, locale: Locale = .autoupdatingCurrent, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        let display = DateFormatter()
        display.locale = locale
        display.timeZone = timeZone
        display.setLocalizedDateFormatFromTemplate("MMMdjmmz")
        return display.string(from: date)
    }
}
