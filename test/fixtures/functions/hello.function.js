export default {
    name: "hello",
    description: "Say hello",
    parameters: {
        type: "object",
        properties: {
            name: { type: "string" }
        },
        required: ["name"]
    },
    execute: async ({ name }) => {
        return `Hello, ${name}!`;
    }
};
