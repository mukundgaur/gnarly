import FirebaseFirestore
import XCTest
@testable import GnarlyMapper

final class FirebaseModelsTests: XCTestCase {
    func testNavigationNodeEncodesNestedPosition() throws {
        let node = NavigationNode(
            id: "stairs-bottom",
            floorId: "ground",
            zoneId: "zone-a",
            type: "stairs",
            position: Position3D(x: 6, y: 0, z: 11)
        )

        let data = try Firestore.Encoder().encode(node)
        XCTAssertEqual(data["floorId"] as? String, "ground")
        XCTAssertEqual(data["zoneId"] as? String, "zone-a")
        let position = try XCTUnwrap(data["position"] as? [String: Any])
        XCTAssertEqual(position["x"] as? Double, 6)
        XCTAssertEqual(position["y"] as? Double, 0)
        XCTAssertEqual(position["z"] as? Double, 11)
    }

    func testNavigationEdgeEncodesExpectedFields() throws {
        let edge = NavigationEdge(
            id: nil,
            from: "entrance",
            to: "stairs-bottom",
            kind: "hallway",
            meters: 13,
            bidirectional: true,
            accessible: true
        )
        let data = try Firestore.Encoder().encode(edge)
        XCTAssertEqual(data["from"] as? String, "entrance")
        XCTAssertEqual(data["to"] as? String, "stairs-bottom")
        XCTAssertEqual(data["meters"] as? Double, 13)
        XCTAssertEqual(data["bidirectional"] as? Bool, true)
    }
}
