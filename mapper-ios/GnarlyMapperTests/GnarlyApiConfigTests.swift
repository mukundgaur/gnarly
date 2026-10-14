import XCTest
@testable import GnarlyMapper

final class GnarlyApiConfigTests: XCTestCase {
    func testAcceptsLocalAndHttpsOrigins() throws {
        XCTAssertEqual(try GnarlyApiConfig.url(from: "http://127.0.0.1:8080").host, "127.0.0.1")
        XCTAssertEqual(try GnarlyApiConfig.url(from: "http://localhost:8080").host, "localhost")
        XCTAssertEqual(try GnarlyApiConfig.url(from: "https://gnarly-api.example.run.app").scheme, "https")
    }

    func testRejectsCleartextRemoteOrigins() {
        XCTAssertThrowsError(try GnarlyApiConfig.url(from: "http://example.com"))
        XCTAssertThrowsError(try GnarlyApiConfig.url(from: ""))
        XCTAssertThrowsError(try GnarlyApiConfig.url(from: nil))
    }
}
