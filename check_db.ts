const rawName = "123e4567-e89b-12d3-a456-426614174000-123e4567-e89b-12d3-a456-426614174000-1779606068263-My_Awesome-File.pdf";
const match = rawName.match(/-\d{13}-(.+)$/);
if (match) {
    console.log("Extracted:", match[1]);
} else {
    console.log("No match");
}
