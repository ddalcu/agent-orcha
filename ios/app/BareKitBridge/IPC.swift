import Foundation

struct IPC: AsyncSequence {
    let ipc: BareIPC

    init(worklet: Worklet) {
        self.ipc = BareIPC(worklet: worklet.worklet)!
    }

    func read() async throws -> Data? {
        return try await ipc.read()
    }

    func write(data: Data) async throws {
        return try await ipc.write(data)
    }

    func close() {
        ipc.close()
    }

    typealias Element = Data

    struct AsyncIterator: AsyncIteratorProtocol {
        let ipc: IPC

        func next() async throws -> Data? {
            return try await ipc.read()
        }
    }

    func makeAsyncIterator() -> AsyncIterator {
        return AsyncIterator(ipc: self)
    }
}
